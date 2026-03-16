declare module 'https-proxy-agent' {
  import { Agent } from 'https';
  export class HttpsProxyAgent extends Agent {
    constructor(proxy: string | URL);
  }
}
