// A small in-memory BM25 index (Okapi BM25, k1 1.2, b 0.75). The take builder keeps one over
// the whole catalog (~16,000 short docs: names, tickers, themes, prediction questions) and lets
// the model search it with a tool call. Postgres here has no BM25 (no pg_search), and at this
// size an index in the worker is built in well under a second and searched in about a millisecond.

const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in", "is", "it", "its", "of", "on", "or",
  "that", "the", "this", "to", "was", "will", "with", "inc", "corp", "corporation", "co", "ltd", "plc", "group",
  "holdings", "company", "common", "backpack", "securities", "xstock", "tokenized",
]);

/**
 * One spelling per thing, on both sides of a search: what people write ("bitcoin") meets what the
 * catalog lists ("BTC price on December 31").
 */
const CANON: Record<string, string> = {
  bitcoin: "btc", ethereum: "eth", ether: "eth", solana: "sol", ripple: "xrp", zcash: "zec", dogecoin: "doge",
  spx: "sp", nikkei: "japan", jobless: "unemployment", jobs: "unemployment",
};

/**
 * Words a take uses for something the catalog names differently: Gemini calls the Super Bowl
 * "Pro Football Champion". Each adds the catalog's words to the text it's found in.
 */
const PHRASES: [RegExp, string][] = [
  [/\bsuper ?bowl\b|\bnfl\b/, "pro football champion"],
  [/\bnba\b|\bnba finals\b/, "pro basketball champion"],
  [/\bstanley cup\b|\bnhl\b/, "pro hockey champion"],
  [/\bworld series\b|\bmlb\b/, "pro baseball champion"],
  [/\bmarch madness\b|\bncaa tournament\b|\bfinal four\b/, "college basketball champion"],
  [/\bcfp\b|\bcollege football playoff\b/, "college football national championship"],
  [/\bchampions league\b|\bucl\b/, "champions league winner"],
  [/\bpremier league\b|\bepl\b/, "english premier league champion"],
  [/\brate cuts?\b|\bcuts? rates\b|\binterest rates?\b|\bfomc\b|\bfederal reserve\b/, "fed decision"],
  [/\bnasdaq ?100\b|\bndx\b/, "nasdaq 100"],
  [/\bs ?& ?p\b|\bs ?and ?p\b/, "sp 500"],
];

/**
 * What a take calls a team, mapped to the city Gemini titles its games by ("Minnesota vs Green
 * Bay"): only added to queries (a take), never to catalog text, so it doesn't slow the build.
 * Where two leagues share a nickname both cities are added; BM25 sorts out which one matches.
 */
const TEAMS: Record<string, string> = {
  "cardinals": "arizona st louis",
  "falcons": "atlanta",
  "ravens": "baltimore",
  "bills": "buffalo",
  "panthers": "carolina florida",
  "bears": "chicago",
  "bengals": "cincinnati",
  "browns": "cleveland",
  "cowboys": "dallas",
  "broncos": "denver",
  "lions": "detroit",
  "packers": "green bay",
  "texans": "houston",
  "colts": "indianapolis",
  "jaguars": "jacksonville",
  "chiefs": "kansas city",
  "raiders": "las vegas",
  "chargers": "los angeles",
  "rams": "los angeles",
  "dolphins": "miami",
  "vikings": "minnesota",
  "patriots": "new england",
  "saints": "new orleans",
  "giants": "new york san francisco",
  "jets": "new york winnipeg",
  "eagles": "philadelphia",
  "steelers": "pittsburgh",
  "49ers": "san francisco",
  "niners": "san francisco",
  "seahawks": "seattle",
  "buccaneers": "tampa bay",
  "bucs": "tampa bay",
  "titans": "tennessee",
  "commanders": "washington",
  "hawks": "atlanta",
  "celtics": "boston",
  "nets": "brooklyn",
  "hornets": "charlotte",
  "bulls": "chicago",
  "cavaliers": "cleveland",
  "cavs": "cleveland",
  "mavericks": "dallas",
  "mavs": "dallas",
  "nuggets": "denver",
  "pistons": "detroit",
  "warriors": "golden state",
  "rockets": "houston",
  "pacers": "indiana",
  "clippers": "los angeles",
  "lakers": "los angeles",
  "grizzlies": "memphis",
  "heat": "miami",
  "bucks": "milwaukee",
  "timberwolves": "minnesota",
  "wolves": "minnesota",
  "pelicans": "new orleans",
  "knicks": "new york",
  "thunder": "oklahoma city",
  "magic": "orlando",
  "76ers": "philadelphia",
  "sixers": "philadelphia",
  "suns": "phoenix",
  "blazers": "portland",
  "kings": "sacramento los angeles",
  "spurs": "san antonio tottenham",
  "raptors": "toronto",
  "jazz": "utah",
  "wizards": "washington",
  "ducks": "anaheim",
  "bruins": "boston",
  "sabres": "buffalo",
  "flames": "calgary",
  "hurricanes": "carolina",
  "blackhawks": "chicago",
  "avalanche": "colorado",
  "blue jackets": "columbus",
  "stars": "dallas",
  "red wings": "detroit",
  "oilers": "edmonton",
  "wild": "minnesota",
  "canadiens": "montreal",
  "habs": "montreal",
  "predators": "nashville",
  "devils": "new jersey",
  "islanders": "new york",
  "rangers": "new york texas",
  "senators": "ottawa",
  "flyers": "philadelphia",
  "penguins": "pittsburgh",
  "sharks": "san jose",
  "kraken": "seattle",
  "blues": "st louis",
  "lightning": "tampa bay",
  "maple leafs": "toronto",
  "leafs": "toronto",
  "canucks": "vancouver",
  "golden knights": "vegas las vegas",
  "capitals": "washington",
  "mammoth": "utah",
  "diamondbacks": "arizona",
  "braves": "atlanta",
  "orioles": "baltimore",
  "red sox": "boston",
  "cubs": "chicago",
  "white sox": "chicago",
  "reds": "cincinnati",
  "guardians": "cleveland",
  "rockies": "colorado",
  "tigers": "detroit",
  "astros": "houston",
  "royals": "kansas city",
  "angels": "los angeles",
  "dodgers": "los angeles",
  "marlins": "miami",
  "brewers": "milwaukee",
  "twins": "minnesota",
  "mets": "new york",
  "yankees": "new york",
  "athletics": "oakland sacramento",
  "phillies": "philadelphia",
  "pirates": "pittsburgh",
  "padres": "san diego",
  "mariners": "seattle",
  "rays": "tampa bay",
  "blue jays": "toronto",
  "nationals": "washington",
  "man city": "manchester city",
  "man utd": "manchester united",
  "man united": "manchester united",
  "barca": "barcelona",
  "psg": "paris saint germain",
  "gunners": "arsenal",
  "reds liverpool": "liverpool",
};
const TEAM_RE = new RegExp(`\\b(${Object.keys(TEAMS).sort((a, b) => b.length - a.length).join("|")})\\b`, "g");

/**
 * Lowercase words, stopwords out, a trailing plural "s" dropped ("chips" finds "chip"). "S&P"
 * becomes "sp" and letters and digits split ("SP500" → "sp 500"), so the two spellings meet;
 * numbers lose their thousands commas and "k" ("100k" and "100,000" are both "100000"). `query`:
 * also add the cities of the teams it names (TEAMS).
 */
export function tokenize(text: string, query = false): string[] {
  let t = text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  for (const [re, add] of PHRASES) if (re.test(t)) t += ` ${add}`;
  if (query) t += " " + [...t.matchAll(TEAM_RE)].map((m) => TEAMS[m[1]]).join(" ");
  t = t.replace(/\b([a-z]{1,2})\s*&\s*([a-z]{1,2})\b/g, "$1$2");
  // "7,000" → "7000", "100k" → "100000": a take's number meets a price range's.
  t = t.replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/(\d+(?:\.\d+)?)\s?k\b/g, (_, n) => String(Math.round(Number(n) * 1000)));
  const out: string[] = [];
  for (const word of t.split(/[^a-z0-9]+/)) {
    for (const raw of word.match(/[a-z]+|[0-9]+/g) ?? []) {
      if (STOP.has(raw)) continue;
      const w = raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
      out.push(CANON[w] ?? CANON[raw] ?? w);
    }
  }
  return out;
}

export class BM25 {
  private postings = new Map<string, { doc: number; tf: number }[]>();
  private lengths: number[] = [];
  private avg = 0;

  /** `fields`: per doc, [text, weight] pairs; a weight of 2 counts that text's words twice. */
  constructor(docs: [string, number][][], private k1 = 1.2, private b = 0.75) {
    docs.forEach((fields, doc) => {
      const tf = new Map<string, number>();
      let length = 0;
      for (const [text, weight] of fields) {
        for (const t of tokenize(text)) {
          tf.set(t, (tf.get(t) ?? 0) + weight);
          length += weight;
        }
      }
      this.lengths.push(length);
      for (const [t, n] of tf) {
        let list = this.postings.get(t);
        if (!list) this.postings.set(t, (list = []));
        list.push({ doc, tf: n });
      }
    });
    this.avg = this.lengths.reduce((a, n) => a + n, 0) / Math.max(1, this.lengths.length);
  }

  /** Docs by score, best first; `keep` filters before ranking. `matched`: how many query words it has. */
  search(query: string, limit: number, keep: (doc: number) => boolean = () => true): { doc: number; score: number; matched: number }[] {
    const scores = new Map<number, number>();
    const matched = new Map<number, number>();
    const n = this.lengths.length;
    for (const t of new Set(tokenize(query, true))) {
      const list = this.postings.get(t);
      if (!list) continue;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const { doc, tf } of list) {
        const norm = tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + this.b * this.lengths[doc] / this.avg));
        scores.set(doc, (scores.get(doc) ?? 0) + idf * norm);
        matched.set(doc, (matched.get(doc) ?? 0) + 1);
      }
    }
    const out: { doc: number; score: number; matched: number }[] = [];
    for (const [doc, score] of scores) if (keep(doc)) out.push({ doc, score, matched: matched.get(doc)! });
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
