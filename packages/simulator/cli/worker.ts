import { runWire, type WireRequest } from "./wire.js";

/** The workerd entry: POST a WireRequest, receive the WireResponse and the runtime identifier. */
export default {
  async fetch(request: { json(): Promise<unknown> }): Promise<Response> {
    const response = await runWire((await request.json()) as WireRequest);
    return new Response(JSON.stringify(response), {
      headers: { "x-clockgrove-runtime": navigator.userAgent },
    });
  },
};
