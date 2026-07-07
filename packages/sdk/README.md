# @barkan/sdk

Typed Node client for Barkan agent-facing APIs.

```ts
import { Barkan } from "@barkan/sdk";

const barkan = new Barkan({
  apiUrl: "https://api.barkan.dev",
  token: process.env.BARKAN_IDENTITY_TOKEN
});

const identity = await barkan.whoami();
await barkan.email.send({
  to: "person@example.com",
  subject: "Hello",
  text: "Hi from my agent."
});
```

Environment fallback:

```bash
BARKAN_API_URL=https://api.barkan.dev
BARKAN_IDENTITY_TOKEN=brk_live_...
```

Build and test:

```bash
npm --workspace @barkan/sdk run generate
npm --workspace @barkan/sdk run build
npm --workspace @barkan/sdk run test
```
