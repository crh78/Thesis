// Solana Actions and the browser fallback. Run on a separate listener from the
// local app API so exposing a preview doesn't expose funding or digest routes.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { ApiError, MIN_STAKE_USD, type ForkService } from "../../scripts/fork/api/service.ts";
import { UUID, body } from "../../scripts/fork/api/server.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding",
  "access-control-expose-headers": "X-Action-Version, X-Blockchain-Ids",
};

const checkoutBundle = new URL("./dist/checkout.js", import.meta.url);
const checkoutStyle = new URL("./checkout.css", import.meta.url);

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function blinkServer(
  service: Pick<ForkService, "blinkTake" | "buildBlinkBack" | "submitBlinkBack" | "receipt">,
  origin: string,
  chainId: string,
  log: (message: string) => void,
) {
  const icon = new URL("/blink-icon.png", origin).href;
  const headers = {
    ...cors, "x-action-version": "2.4", "x-blockchain-ids": chainId,
    "cache-control": "no-store", "x-content-type-options": "nosniff",
  };
  return createServer(async (req, res) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(req.url ?? "/", origin);
      const method = req.method;
      const mapping = url.pathname === "/actions.json";
      const action = url.pathname.match(/^\/api\/actions\/back\/([^/]+)$/);
      const receiptRoute = url.pathname.match(/^\/api\/blink\/receipt\/([^/]+)$/);
      const page = url.pathname.match(/^\/take\/([^/]+)$/);
      if (method === "OPTIONS" && (mapping || action)) {
        res.writeHead(204, headers).end();
        return;
      }
      if (method === "GET" && mapping) {
        return send(200, { rules: [
          { pathPattern: "/take/*", apiPath: "/api/actions/back/*" },
          { pathPattern: "/api/actions/back/*", apiPath: "/api/actions/back/*" },
        ] });
      }
      if (method === "GET" && url.pathname === "/blink-icon.png") {
        const image = readFileSync(new URL("../ios/Thesis/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png", import.meta.url));
        res.writeHead(200, { ...headers, "content-type": "image/png" }).end(image);
        return;
      }
      if (method === "GET" && url.pathname === "/blink/checkout.js") {
        if (!existsSync(checkoutBundle)) throw new ApiError(503, "checkout_unbuilt", "Build the web checkout first.");
        res.writeHead(200, { ...headers, "content-type": "text/javascript" }).end(readFileSync(checkoutBundle));
        return;
      }
      if (method === "GET" && url.pathname === "/blink/checkout.css") {
        res.writeHead(200, { ...headers, "content-type": "text/css" }).end(readFileSync(checkoutStyle));
        return;
      }
      if (method === "POST" && url.pathname === "/api/blink/submit") {
        const { checkoutId, transaction } = await body(req);
        if (typeof checkoutId !== "string" || !UUID.test(checkoutId) || typeof transaction !== "string" || transaction.length > 1644) {
          throw new ApiError(400, "invalid_checkout", "The wallet checkout or signed transaction is invalid.");
        }
        return send(200, await service.submitBlinkBack(checkoutId, transaction));
      }
      const id = action?.[1] ?? page?.[1] ?? receiptRoute?.[1];
      if (!id) throw new ApiError(404, "not_found", "Page not found.");
      if (!UUID.test(id)) throw new ApiError(400, "invalid_take_id", "Invalid take ID.");
      const actionPath = `/api/actions/back/${id}`;

      if (method === "GET") {
        if (receiptRoute) {
          const receipt = await service.receipt(id, undefined, { routes: false });
          return send(200, receipt.onChain
            ? { onChain: true, backers: receipt.backers, totalBackedUsd: receipt.totalBackedUsd }
            : { onChain: false });
        }
        const take = await service.blinkTake(id);
        if (page) {
          const receipt = await service.receipt(id, undefined, { routes: false });
          const claim = escape(take.claim);
          const author = take.handle ? ` by @${escape(take.handle)}` : "";
          const legs = take.legs.map((leg) => `<li>${escape(leg.name)}</li>`).join("");
          const summary = receipt.onChain
            ? `Backs: ${receipt.backers} · Backed: ${receipt.totalBackedUsd.toFixed(2)} USDC`
            : "This take has no fork receipt yet.";
          const checkout = take.canBack && existsSync(checkoutBundle)
            ? `<section id="checkout" data-action="${actionPath}" data-chain="${escape(chainId)}" data-receipt="/api/blink/receipt/${id}">
                <h2>Back this take</h2>
                <p class="muted">Back up to three eligible spot or yield legs with fake USDC. Use a funded fork wallet.</p>
                <form><label>USDC amount <input name="amount" type="number" min="${MIN_STAKE_USD}" step="0.01" value="${MIN_STAKE_USD}" required></label>
                <button type="submit">Connect wallet</button><button id="reset" type="button" hidden>Edit amount</button></form>
                <p id="review"></p><p id="checkout-status" role="status" aria-live="polite"></p>
                <code id="confirmed-signature"></code>
              </section><script type="module" src="/blink/checkout.js"></script>`
            : `<p>${take.canBack ? "Browser checkout is unavailable. Open Thesis to back this take." : "This take isn't available to back on the fork."}</p>`;
          res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8",
            "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
          res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
            <title>${claim} · Thesis</title><link rel="stylesheet" href="/blink/checkout.css">
            <meta name="twitter:card" content="summary"><meta property="og:title" content="${claim} · Thesis">
            <meta property="og:description" content="Back this take on the Thesis fork with fake USDC.">
            <meta property="og:image" content="${escape(icon)}"></head><body><main>
            <p class="eyebrow">Thesis · Fork preview</p><h1>${claim}</h1><p class="muted">Take${author}</p>
            <p id="receipt-summary">${summary}</p>${checkout}<h2>Basket</h2><ul>${legs}</ul>
            <p><a href="yourthesis-dev://take/${id}">Open the full take in Thesis</a></p>
            </main></body></html>`);
          return;
        }
        const author = take.handle ? ` by @${take.handle}` : "";
        return send(200, {
          type: "action", icon, title: take.claim, label: "Back this take",
          description: `Fork preview${author}. Back up to three spot or yield legs with fake USDC. Open Thesis for the full basket.`,
          ...(take.canBack ? { links: { actions: [
            { type: "transaction", label: "Back 10 USDC", href: `${actionPath}?amount=10` },
            { type: "transaction", label: "Back this take", href: `${actionPath}?amount={amount}`, parameters: [
              { name: "amount", label: `Amount in USDC (minimum ${MIN_STAKE_USD})`, type: "number", required: true, min: MIN_STAKE_USD },
            ] },
          ] } } : { disabled: true, error: { message: "This take isn't available to back on the fork." } }),
        });
      }

      if (method === "POST" && action) {
        const { account } = await body(req);
        if (typeof account !== "string" || !account) throw new ApiError(400, "invalid_account", "A wallet address is required.");
        const amount = url.searchParams.get("amount") ?? "";
        if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) throw new ApiError(400, "invalid_amount", "Enter a USDC amount with up to two decimals.");
        const built = await service.buildBlinkBack(id, account, Number(amount), url.searchParams.get("checkout") === "1");
        const omitted = built.excluded.length ? ` Omitted: ${built.excluded.map((leg) => leg.name).join(", ")}.` : "";
        const message = `Back ${amount} USDC on ${built.included.length} leg(s), plus ${built.feeUsd} USDC Thesis fee and network costs.${omitted}`;
        return send(200, {
          type: "transaction", transaction: built.transaction, message, checkoutId: built.checkoutId,
          links: { next: { type: "inline", action: {
            type: "completed", icon, title: "You're in", label: "Back confirmed",
            description: "Your back was recorded. Open the full take in Thesis to view its receipt and follow the author.",
          } } },
        });
      }
      res.setHeader("allow", action ? "GET, POST, OPTIONS" : "GET");
      throw new ApiError(405, "method_not_allowed", "Method not allowed.");
    } catch (error) {
      if (error instanceof ApiError) return send(error.status, { message: error.message });
      log(`Blink error: ${error instanceof Error ? error.message : String(error)}`);
      return send(500, { message: "Couldn't load this Blink. Try again or open the take in Thesis." });
    }
  });
}
