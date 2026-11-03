import { describe, expect, it } from "vitest";
import { hostOf, isInsecureRemote, isPrivateHost, normalizeServerUrl } from "../src/logic/serverUrl";

describe("normalizeServerUrl", () => {
  it("スキーム省略時は https", () => {
    expect(normalizeServerUrl("example.com")).toBe("https://example.com");
    expect(normalizeServerUrl("192.168.1.10:3000")).toBe("https://192.168.1.10:3000");
  });
  it("http/https は保持し末尾スラッシュと空白を除去", () => {
    expect(normalizeServerUrl("  http://10.0.2.2:3000// ")).toBe("http://10.0.2.2:3000");
    expect(normalizeServerUrl("HTTPS://a.b/")).toBe("HTTPS://a.b");
  });
  it("空は空", () => {
    expect(normalizeServerUrl("   ")).toBe("");
  });
});

describe("isPrivateHost", () => {
  it.each(["localhost", "127.0.0.1", "10.0.2.2", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.0.5", "nas.local", "::1"])("%s は私的", (h) => {
    expect(isPrivateHost(h)).toBe(true);
  });
  it.each(["example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "11.0.0.1", "300.168.1.1", "evil-local.com", ""])("%s は私的でない", (h) => {
    expect(isPrivateHost(h)).toBe(false);
  });
});

describe("isInsecureRemote", () => {
  it("外部ホストへの http は true", () => {
    expect(isInsecureRemote("http://example.com")).toBe(true);
    expect(isInsecureRemote("http://8.8.8.8:3000")).toBe(true);
  });
  it("https とプライベート http は false", () => {
    expect(isInsecureRemote("https://example.com")).toBe(false);
    expect(isInsecureRemote("http://192.168.1.10:3000")).toBe(false);
    expect(isInsecureRemote("http://localhost:3000")).toBe(false);
    expect(isInsecureRemote("http://[::1]:3000")).toBe(false);
  });
  it("hostOf", () => {
    expect(hostOf("http://[::1]:3000")).toBe("::1");
    expect(hostOf("garbage")).toBe("");
  });
});
