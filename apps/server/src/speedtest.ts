import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * 隧道测速的采样结果。速率统一按「传输窗口」计算：窗口 = 总耗时 - 首字节等待，
 * 否则 TLS 握手与建连时间会被算进传输耗时，小数据量时速率会被严重低估。
 */
export interface SpeedSample {
  /** 实际传输的字节数。下行达到上限被主动中断、上行中途失败时会小于请求量。 */
  bytes: number;
  /** 从发起请求到本次采样结束的毫秒数。 */
  elapsedMs: number;
  /** 传输窗口内的平均速率（Mbps）。 */
  mbps: number;
  /** 首个响应字节到达耗时；上行测速不关心，固定为 null。 */
  ttfbMs: number | null;
  /** 目标服务返回的状态码；未收到响应时为 0。 */
  status: number;
  /** 采样是否被截断（下行触及数据量上限，或上行未能写完）。 */
  truncated: boolean;
}

export interface SpeedTestOptions {
  /** 完整的公网访问地址，调用方必须已校验为 http/https。 */
  url: string;
  /** 单次采样的数据量上限，单位字节。 */
  sizeBytes: number;
  /** 整体超时，超时后按已传输的字节数结算而不是直接报错。 */
  timeoutMs: number;
}

const USER_AGENT = "Nexious-SpeedTest/1.0";
// 上行分片大小：越大越接近大包吞吐，但过大会让背压粒度变粗、速率抖动明显。
const UPLOAD_CHUNK_BYTES = 64 * 1024;

function transportFor(target: URL) {
  return target.protocol === "http:" ? httpRequest : httpsRequest;
}

function toMbps(bytes: number, windowMs: number) {
  return windowMs > 0 ? (bytes * 8) / (windowMs / 1000) / 1_000_000 : 0;
}

/**
 * 下行测速：流式读取响应体并统计字节数与耗时，达到 sizeBytes 后主动断开，
 * 因此目标文件远大于上限时也不会把整文件读进内存。
 */
export function measureDownload({ url, sizeBytes, timeoutMs }: SpeedTestOptions): Promise<SpeedSample> {
  const target = new URL(url);
  return new Promise<SpeedSample>((resolve, reject) => {
    const startedAt = Date.now();
    let firstByteAt: number | null = null;
    let bytes = 0;
    let status = 0;
    let truncated = false;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      const endedAt = Date.now();
      resolve({
        bytes,
        elapsedMs: endedAt - startedAt,
        mbps: toMbps(bytes, endedAt - (firstByteAt ?? startedAt)),
        ttfbMs: firstByteAt === null ? null : firstByteAt - startedAt,
        status,
        truncated
      });
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = transportFor(target)(
      target,
      {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          // 关闭压缩：否则统计到的是压缩后字节，与实际带宽占用不符。
          "accept-encoding": "identity",
          "cache-control": "no-cache"
        }
      },
      (response) => {
        status = response.statusCode || 0;
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          if (firstByteAt === null) firstByteAt = Date.now();
          bytes += chunk.length;
          if (bytes >= sizeBytes) {
            truncated = true;
            response.destroy();
            settle();
          }
        });
        response.on("end", settle);
        response.on("error", fail);
      }
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      settle();
    });
    // 已经读到数据时按已收字节结算，让"大文件慢速"也能拿到有意义的速率。
    request.on("error", (error) => (bytes > 0 ? settle() : fail(error)));
    request.end();
  });
}

/**
 * 上行测速：按分片写入并处理背压，以「请求体全部写入内核」的时刻作为传输结束。
 * 目标服务返回 4xx/5xx 也照样能测出发送速率，因此状态码只做展示、不参与成功率判断。
 */
export function measureUpload({ url, sizeBytes, timeoutMs }: SpeedTestOptions): Promise<SpeedSample> {
  const target = new URL(url);
  return new Promise<SpeedSample>((resolve, reject) => {
    const startedAt = Date.now();
    const chunk = randomBytes(UPLOAD_CHUNK_BYTES);
    let written = 0;
    let status = 0;
    let flushedAt: number | null = null;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      // 对端可能先回状态码再关连接，此时以请求体写完的时刻为准。
      const endedAt = flushedAt ?? Date.now();
      resolve({
        bytes: written,
        elapsedMs: endedAt - startedAt,
        mbps: toMbps(written, endedAt - startedAt),
        ttfbMs: null,
        status,
        truncated: written < sizeBytes
      });
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = transportFor(target)(
      target,
      {
        method: "POST",
        headers: {
          "user-agent": USER_AGENT,
          "content-type": "application/octet-stream",
          "content-length": String(sizeBytes),
          "x-nexious-speedtest": "upload",
          connection: "close"
        }
      },
      (response) => {
        status = response.statusCode || 0;
        // 响应体与上行速率无关，但必须读掉才能让连接正常收尾。
        response.resume();
        response.on("end", settle);
        response.on("error", settle);
      }
    );
    // 写入完成才意味着数据真正交给内核发送，这是上行速率最接近真实的采样点。
    request.on("finish", () => {
      flushedAt = Date.now();
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      settle();
    });
    request.on("error", (error) => (written > 0 ? settle() : fail(error)));
    const pump = () => {
      while (written < sizeBytes) {
        const size = Math.min(chunk.length, sizeBytes - written);
        written += size;
        if (!request.write(size === chunk.length ? chunk : chunk.subarray(0, size))) {
          request.once("drain", pump);
          return;
        }
      }
      request.end();
    };
    pump();
  });
}