// The BlueBubbles adapter against a stand-in server: it answers a group message once, in that
// group, and never answers its own messages or reactions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { bluebubbles } from "../src/providers/bluebubbles.ts";
import type { Inbound } from "../src/types.ts";

test("replies in the group, skips its own messages and reactions", async () => {
  const sent: Array<{ chatGuid: string; message: string }> = [];
  let served = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    let body = "";
    for await (const c of req) body += c;
    if (url.searchParams.get("password") !== "pw") {
      res.writeHead(401).end("{}");
      return;
    }
    if (url.pathname === "/api/v1/ping") return void res.end(JSON.stringify({ message: "pong" }));
    if (url.pathname === "/api/v1/message/query") {
      const q = JSON.parse(body);
      const group = [{ guid: "iMessage;+;chat42" }];
      const data = served ? [] : [
        { guid: "m1", text: "thesis nvidia keeps winning", isFromMe: false, dateCreated: q.after + 1, handle: { address: "+15550001111" }, chats: group },
        { guid: "m2", text: "my own reply", isFromMe: true, dateCreated: q.after + 2, chats: group },
        { guid: "m3", text: "Loved “x”", isFromMe: false, dateCreated: q.after + 3, associatedMessageGuid: "m1", chats: group },
      ];
      served = true;
      return void res.end(JSON.stringify({ data }));
    }
    if (url.pathname === "/api/v1/message/text") {
      sent.push(JSON.parse(body));
      return void res.end(JSON.stringify({ data: { guid: "out1" } }));
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  const provider = bluebubbles({ url: `http://127.0.0.1:${port}`, password: "pw" });
  const seen: Inbound[] = [];
  const running = provider.run(async (m) => {
    seen.push(m);
    return "on it";
  });
  await new Promise((r) => setTimeout(r, 2_500));
  await provider.stop();
  await running;
  server.close();

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { provider: "bluebubbles", chatId: "iMessage;+;chat42", chatType: "group", senderId: "+15550001111", text: "thesis nvidia keeps winning" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatGuid, "iMessage;+;chat42");
  assert.equal(sent[0].message, "on it");
});

test("a wrong password fails at start", async () => {
  const server = createServer((_req, res) => void res.writeHead(401).end("{}"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  await assert.rejects(bluebubbles({ url: `http://127.0.0.1:${port}`, password: "nope" }).run(async () => null), /401/);
  server.close();
});
