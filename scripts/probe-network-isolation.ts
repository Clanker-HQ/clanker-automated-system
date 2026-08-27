/**
 * Probes whether the PR-review test-execution step can run with network
 * access disabled, on this machine. Linux has straightforward options
 * (unshare --net, firejail --net=none); Windows does not have an equivalent
 * built-in primitive. Run this manually — `npx tsx scripts/probe-network-isolation.ts`
 * — and read the printed result before Task 12 depends on its answer.
 */
import { execSync } from "node:child_process";
import { platform } from "node:os";

console.log(`Platform: ${platform()}`);

if (platform() === "linux") {
  try {
    const result = execSync("unshare --net -- curl -s --max-time 2 https://example.com -o /dev/null -w '%{http_code}'", { encoding: "utf8" });
    console.log(`unshare --net curl result: "${result}" (expect a failure/timeout, not a 200)`);
  } catch (err) {
    console.log("unshare --net blocked the network call as expected:", (err as Error).message.slice(0, 200));
  }
} else {
  console.log(
    "No built-in Windows primitive for per-process network isolation exists (no unshare equivalent). " +
      "On this platform, network-off-during-test-execution is NOT currently enforceable — this is a real, " +
      "documented gap for local dev/test, closed once this runs on the Linux VPS per the spec's deployment plan.",
  );
}
