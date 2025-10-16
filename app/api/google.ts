import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { getServerSideConfig } from "@/app/config/server";
import { ApiPath, GEMINI_BASE_URL, ModelProvider } from "@/app/constant";
import { prettyObject } from "@/app/utils/format";

const serverConfig = getServerSideConfig();

export async function handle(
  req: NextRequest,
  { params }: { params: { provider: string; path: string[] } },
) {
  console.log("[Google Route] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const authResult = auth(req, ModelProvider.GeminiPro);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  const bearToken =
    req.headers.get("x-goog-api-key") || req.headers.get("Authorization") || "";
  const token = bearToken.trim().replaceAll("Bearer ", "").trim();

  const apiKey = token ? token : serverConfig.googleApiKey;

  if (!apiKey) {
    return NextResponse.json(
      {
        error: true,
        message: `missing GOOGLE_API_KEY in server env vars`,
      },
      {
        status: 401,
      },
    );
  }
  try {
    const response = await request(req, apiKey);
    return response;
  } catch (e) {
    console.error("[Google] ", e);
    return NextResponse.json(prettyObject(e));
  }
}

export const GET = handle;
export const POST = handle;

export const runtime = "edge";
export const preferredRegion = [
  "bom1",
  "cle1",
  "cpt1",
  "gru1",
  "hnd1",
  "iad1",
  "icn1",
  "kix1",
  "pdx1",
  "sfo1",
  "sin1",
  "syd1",
];

async function request(req: NextRequest, apiKey: string) {
  const controller = new AbortController();

  let baseUrl = serverConfig.googleUrl || GEMINI_BASE_URL;

  let path = `${req.nextUrl.pathname}`.replaceAll(ApiPath.Google, "");

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[Proxy] ", path);
  console.log("[Base Url]", baseUrl);

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );
  const fetchUrl = `${baseUrl}${path}${
    req?.nextUrl?.searchParams?.get("alt") === "sse" ? "?alt=sse" : ""
  }`;

  console.log("[Fetch Url] ", fetchUrl);
  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-goog-api-key":
        req.headers.get("x-goog-api-key") ||
        (req.headers.get("Authorization") ?? "").replace("Bearer ", ""),
    },
    method: req.method,
    body: req.body,
    // to fix #2485: https://stackoverflow.com/questions/55920957/cloudflare-worker-typeerror-one-time-use-body
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };


  // ------ Changed Here ------
  // 添加一个 2s 的心跳，防止流式一直不出结果

  const USE_INTERVAL_REAL_WRITE = true;
  const HEARTBEAT_INTERVAL = 2 * 1000;

  let intervalId: any;
  let intervalRealWrite: any;
  let intervalRealWrite_wrote = false;
  let nowTime = Date.now();

  let responseStream: ReadableStream;
  const transformStream = new TransformStream();
  const writer = transformStream.writable.getWriter();
  const encoder = new TextEncoder();

  // 启动一个心跳定时器，每 2 秒发送一个无用 SSE 块，以保持及时响应
  if (!USE_INTERVAL_REAL_WRITE) {
    intervalId = setInterval(() => {
      writer.write(encoder.encode(': Waiting...\n\n'));
      console.log("[Alive] SILENCE keep-alive Sent");
    }, HEARTBEAT_INTERVAL);
  }

  // 启动一个心跳定时器，每 2 秒发送一个 Waiting... 后面的小点点，以保持及时响应
  else {
    intervalRealWrite = setInterval(() => {
      let writeString = '.';
      if (!intervalRealWrite_wrote) {
        writeString = "> Waiting.";
        intervalRealWrite_wrote = true;
      }
      writer.write(encoder.encode(`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"${writeString}"}]},"finishReason":null,"index":0,"safetyRatings":[]}],"promptFeedback":{"safetyRatings":[]}}\n\n`));
      console.log("[Alive] REAL-WRITE keep-alive Sent");
    }, HEARTBEAT_INTERVAL);
  }

  // 异步运行“真流”
  (async () => {
    try {
      const res = await fetch(fetchUrl, fetchOptions);
  
      if (!res.ok) {
        const errorBody = await res.text();
        const errorEvent = JSON.stringify({ error: true, message: `Upstream Error: ${res.status} ${res.statusText}`, body: errorBody }, null, 2);
        writer.write(encoder.encode(`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"\\n\\n\`\`\`json\\n${errorEvent}\\n\`\`\`"}]},"finishReason":null,"index":0,"safetyRatings":[]}],"promptFeedback":{"safetyRatings":[]}}\n\n`));
        throw new Error(`[Alive] Upstream fetch failed with status ${res.status}`);
      }

      // @ts-ignore
      const reader = res.body.getReader(); 
      const decoder = new TextDecoder();

      // 将“真流”的输入写入我们一开始立即返回的“假流”里
      let done = false;
      let isFirstChunk = true;
      while (!done) {
        if (isFirstChunk) {
          isFirstChunk = false;

          if (!USE_INTERVAL_REAL_WRITE) {
            if (intervalId) {
              clearInterval(intervalId);
              intervalId = null;
            }
          }

          else {
            if (intervalRealWrite) {
              clearInterval(intervalRealWrite);
              intervalRealWrite = null;
            }
            let writeTime = (Date.now() - nowTime) / 1000;
            let writeString = ` (time cost: ${writeTime}s)\\n\\n`;
            if (!intervalRealWrite_wrote) {
              writeString = `> ${writeString}`;
            }
            writer.write(encoder.encode(`data: {"candidates":[{"content":{"role":"model","parts":[{"text":"${writeString}"}]},"finishReason":null,"index":0,"safetyRatings":[]}],"promptFeedback":{"safetyRatings":[]}}\n\n`));
          }

          console.log("[Alive] First chunk received, clearing keep-alive interval.");

        }
        const { value, done: isDone } = await reader.read();
        done = isDone;
        if (value) {
          writer.write(encoder.encode(decoder.decode(value, { stream: true })));
        }
      }

    } catch (e) {
      console.error("[Alive] Stream fetch error:", e);
      const errorMessage = `data: ${JSON.stringify({ error: true, message: (e as Error).message })}\n\n`;
      writer.write(encoder.encode(errorMessage));

    } finally {

      clearTimeout(timeoutId);

      if (!USE_INTERVAL_REAL_WRITE) {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
          console.log("[Alive] SILENCE Stream ended, clearing interval.");
        }
      }

      else {
        if (intervalRealWrite) {
          clearInterval(intervalRealWrite);
          intervalRealWrite = null;
          console.log("[Alive] REAL-WRITE Stream ended, clearing interval.");
        }
      }
  
      writer.close();
      console.log("[Alive] Stream writer closed.");
    }

  })().catch(e => {
      console.error("[Alive] Other error:", e);
  });

  // 立即输出一个“假流”，这样保证有返回值
  responseStream = transformStream.readable;
  return new Response(responseStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });

  // try {
  //   const res = await fetch(fetchUrl, fetchOptions);
  //   // to prevent browser prompt for credentials
  //   const newHeaders = new Headers(res.headers);
  //   newHeaders.delete("www-authenticate");
  //   // to disable nginx buffering
  //   newHeaders.set("X-Accel-Buffering", "no");

  //   return new Response(res.body, {
  //     status: res.status,
  //     statusText: res.statusText,
  //     headers: newHeaders,
  //   });
  // } finally {
  //   clearTimeout(timeoutId);
  // }
}
