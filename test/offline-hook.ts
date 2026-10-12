/** Network-disabled test sandbox, installed in every Node process through inherited NODE_OPTIONS. */
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
const denied = () => {
  throw new Error("M2 offline sandbox: network disabled");
};
net.Socket.prototype.connect = denied as any;
net.connect = denied as any;
net.createConnection = denied as any;
tls.connect = denied as any;
http.request = denied as any;
http.get = denied as any;
https.request = denied as any;
https.get = denied as any;
dns.lookup = denied as any;
dns.resolve = denied as any;
globalThis.fetch = denied as any;
syncBuiltinESMExports();
