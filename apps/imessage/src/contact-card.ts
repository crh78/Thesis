// The bot's own contact card (.vcf): "Thesis", our number, the leaf logo.
// Shared lines can't carry our name and photo (Name & Photo Sharing needs a
// dedicated line), so the first DM gets this card instead. Once someone saves
// it, the thread shows Thesis + the logo, and iMessage expands our links.
import { readFile } from "node:fs/promises";

const LOGO = new URL("../assets/thesis-contact.png", import.meta.url);

/** vCard 3.0 lines are folded at 75 octets with CRLF + space. */
function fold(line: string): string {
  const out: string[] = [];
  for (let i = 0; i < line.length; i += 74) out.push((i ? " " : "") + line.slice(i, i + 74));
  return out.join("\r\n");
}

export async function contactCard(phone: string): Promise<string> {
  const photo = (await readFile(LOGO)).toString("base64");
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:;Thesis;;;",
    "FN:Thesis",
    "ORG:Thesis",
    `TEL;TYPE=CELL:${phone}`,
    "URL:https://yourthesis.xyz",
    "NOTE:Text me a take. I'll turn it into a basket you can back.",
    fold(`PHOTO;ENCODING=b;TYPE=PNG:${photo}`),
    "END:VCARD",
    "",
  ].join("\r\n");
}
