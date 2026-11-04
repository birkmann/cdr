# Building your own frontend

Every CDR interface is a client of the same HTTP + SSE API. The event types and endpoints are listed in [protocol.md](protocol.md).

```ts
import { createClient } from "@harness/client";
const client = createClient({ baseUrl: "http://127.0.0.1:8787", token });
const s = await client.createSession({ projectPath: "/path/to/repo" });
for await (const e of client.events(s.id, { untilDone: true })) {
  if (e.type === "permission.request") await client.answerPermission(s.id, e.id, "allow");
  if (e.type === "plan.proposed") await client.decidePlan(s.id, e.id, "approve");
}
```

React: `useSession(client, sessionId)` from `@harness/react` returns `{ messages, tools, timeline, pendingPermissions, pendingPlan, status, send, cancel, … }`. [apps/web](../apps/web) is the complete reference UI.
