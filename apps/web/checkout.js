import { PublicKey, VersionedTransaction } from "@solana/web3.js";

const panel = document.querySelector("#checkout");
const form = panel.querySelector("form");
const amount = form.elements.amount;
const button = form.querySelector("button");
const review = panel.querySelector("#review");
const reset = panel.querySelector("#reset");
const status = panel.querySelector("#checkout-status");
let wallet;
let account;
let prepared;
let signed;
let completed = false;

function render(message = "") {
  amount.disabled = Boolean(prepared);
  button.disabled = completed;
  button.textContent = completed ? "Back confirmed" : signed ? "Retry submission" :
    prepared ? "Sign and back" : wallet ? "Review back" : "Connect wallet";
  reset.hidden = !prepared || Boolean(signed) || completed;
  status.textContent = message;
}

async function request(path, payload) {
  const response = await fetch(path, payload === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.message ?? "Checkout is unavailable.");
    error.status = response.status;
    throw error;
  }
  if (response.headers.get("x-blockchain-ids") !== panel.dataset.chain) {
    throw new Error("The Action is not connected to this fork.");
  }
  return data;
}

function clearReview() {
  prepared = undefined;
  review.textContent = "";
}

reset.addEventListener("click", () => {
  clearReview();
  render();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  reset.hidden = true;
  try {
    if (!wallet) {
      const provider = [window.backpack?.solana, window.backpack, window.phantom?.solana, window.solana]
        .find((candidate) => candidate?.connect && candidate?.signTransaction);
      if (!provider) throw new Error("Open this page in a browser with a Solana wallet that supports signing on a custom RPC.");
      const connected = await provider.connect();
      account = new PublicKey(connected.publicKey.toString());
      wallet = provider;
      render(`Connected ${account.toBase58().slice(0, 6)}…`);
      return;
    }

    if (!prepared) {
      status.textContent = "Preparing your back…";
      const metadata = await request(panel.dataset.action);
      const linked = metadata.links?.actions?.find((action) => action.parameters?.some((param) => param.name === "amount"));
      if (metadata.disabled || !linked) throw new Error("This take is no longer available to back.");
      const path = new URL(linked.href.replace("{amount}", encodeURIComponent(amount.value)), location.href);
      if (path.origin !== location.origin || path.pathname !== panel.dataset.action) {
        throw new Error("The Action returned an unexpected checkout URL.");
      }
      path.searchParams.set("checkout", "1");
      const draft = await request(path, { account: account.toBase58() });
      const bytes = Uint8Array.from(atob(draft.transaction), (byte) => byte.charCodeAt(0));
      const tx = VersionedTransaction.deserialize(bytes);
      const onlySigner = tx.message.staticAccountKeys[0];
      if (!onlySigner?.equals(account) || tx.message.header.numRequiredSignatures !== 1 ||
          tx.signatures.length !== 1 || tx.signatures[0].some(Boolean) || !draft.checkoutId) {
        throw new Error("The Action returned an unexpected signer or fee payer.");
      }
      prepared = { id: draft.checkoutId, transaction: tx, completion: draft.links?.next?.action?.title };
      review.textContent = draft.message;
      render("Review the basket and fees before signing.");
      return;
    }

    if (!signed) {
      status.textContent = "Approve the transaction in your wallet…";
      if (wallet.publicKey?.toString() !== account.toBase58()) {
        wallet = undefined;
        clearReview();
        throw new Error("The wallet account changed. Connect and review again.");
      }
      const tx = await wallet.signTransaction(prepared.transaction);
      signed = btoa(String.fromCharCode(...tx.serialize()));
    }

    status.textContent = "Confirming on the fork…";
    const { signature } = await request("/api/blink/submit", { checkoutId: prepared.id, transaction: signed });
    completed = true;
    document.querySelector("#confirmed-signature").textContent = signature;
    try {
      const receipt = await request(panel.dataset.receipt);
      if (receipt.onChain) {
        document.querySelector("#receipt-summary").textContent =
          `Backs: ${receipt.backers} · Backed: ${receipt.totalBackedUsd.toFixed(2)} USDC`;
      }
    } catch {
      // The back is already confirmed. The receipt can be refreshed separately.
    }
    render(prepared.completion ?? "Back confirmed.");
  } catch (error) {
    if (signed && [400, 409, 410].includes(error.status)) {
      completed = true;
      render(error.message);
      button.textContent = "Submission ended";
    } else {
      render(error.message || "Checkout failed.");
    }
  }
});
render();
