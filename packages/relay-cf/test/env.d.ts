import type { Env as RelayEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends RelayEnv {
      TEST_ACCOUNT: string;
      TEST_AGENT_KEY: string;
      TEST_AGENT_PUBLIC_KEY: string;
    }
  }
}
