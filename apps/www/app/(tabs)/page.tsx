import Feed from "@/components/Feed";
import type { FeedTake } from "@/components/TakeRow";
import { getFeed } from "@/lib/data";

export const revalidate = 30;

// Home: the feed. The first page of For you comes from the server, then the client keeps it fresh.
export default async function Home() {
  const takes = (await getFeed()) as FeedTake[];
  return <Feed initial={takes.filter((t) => t.status === "live")} />;
}
