package local.novelbackup.app;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * ブロックリストのダウンロード・キャッシュ・解析・マッチャの差し替えを担う(Android 非依存。JUnit でテストする)。
 * 端末の DNS は変更しない。ここで作るのは「ドメイン一致の判定器」だけ。
 *
 *  - apply(urls) は即座に戻り、専用スレッドで処理する。空配列はその場でマッチャを破棄する。
 *  - 重なった呼び出しは世代番号で整理し、古い結果が新しい結果を上書きしない。
 *  - 取得失敗は fail-open: キャッシュがあればそれを使い、無ければそのリストは何も寄与しない。
 *  - 使われなくなったリストのキャッシュは削除する。
 */
final class BlocklistManager {
    static final long MAX_BYTES = 30L * 1024 * 1024;
    static final int MAX_DOMAINS = 500_000;
    static final long CACHE_TTL_MS = 24L * 60 * 60 * 1000;
    static final int MAX_URLS = 40;

    /** URL を dest へ保存する。https 以外(リダイレクト先含む)や maxBytes 超過は IOException。 */
    interface Fetcher {
        void fetch(String url, File dest, long maxBytes) throws IOException;
    }

    /** リスト別の状況。updatedAt はキャッシュの更新時刻(ms)、無ければ 0。error は無ければ null。 */
    static final class Status {
        final String url;
        final int domains;
        final long updatedAt;
        final String error;

        Status(String url, int domains, long updatedAt, String error) {
            this.url = url;
            this.domains = domains;
            this.updatedAt = updatedAt;
            this.error = error;
        }
    }

    private final File dir;
    private final Fetcher fetcher;
    private final ExecutorService exec;
    private final AtomicLong gen = new AtomicLong();
    private final AtomicInteger pending = new AtomicInteger();
    private final Object swapLock = new Object();
    private volatile DomainMatcher matcher = null;
    private volatile List<Status> statuses = Collections.emptyList();

    BlocklistManager(File dir) {
        this(dir, new HttpsFetcher());
    }

    BlocklistManager(File dir, Fetcher fetcher) {
        this.dir = dir;
        this.fetcher = fetcher;
        this.exec = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "blocklist");
            t.setDaemon(true);
            t.setPriority(Thread.MIN_PRIORITY);
            return t;
        });
    }

    /** 現在のマッチャ(無効なら null)。リクエストスレッドから呼ぶので読むだけ。 */
    DomainMatcher matcher() {
        return matcher;
    }

    List<Status> statuses() {
        return statuses;
    }

    boolean isLoading() {
        return pending.get() > 0;
    }

    /** テスト用: 処理中のタスクが終わるまで待つ。 */
    boolean awaitIdle(long timeoutMs) throws InterruptedException {
        long end = System.currentTimeMillis() + timeoutMs;
        while (pending.get() > 0) {
            if (System.currentTimeMillis() > end) return false;
            Thread.sleep(5);
        }
        return true;
    }

    /** 有効にする URL 一覧を設定する。即座に戻る。 */
    void apply(List<String> urls) {
        final List<String> list = sanitize(urls);
        final long my = gen.incrementAndGet();
        if (list.isEmpty()) {
            synchronized (swapLock) {
                matcher = null;
                statuses = Collections.emptyList();
            }
        }
        pending.incrementAndGet();
        try {
            exec.execute(() -> {
                try {
                    run(my, list);
                } catch (Throwable t) {
                    // fail-open: 例外時はマッチャを差し替えない
                } finally {
                    pending.decrementAndGet();
                }
            });
        } catch (RuntimeException e) {
            pending.decrementAndGet();
        }
    }

    static List<String> sanitize(List<String> urls) {
        Set<String> out = new LinkedHashSet<>();
        if (urls != null) {
            for (String u : urls) {
                if (u == null) continue;
                String s = u.trim();
                if (s.length() == 0 || s.length() > 2048) continue;
                try {
                    URL parsed = new URL(s);
                    if (!"https".equals(parsed.getProtocol()) || parsed.getHost() == null || parsed.getHost().isEmpty()) continue;
                } catch (Exception e) {
                    continue;
                }
                out.add(s);
                if (out.size() >= MAX_URLS) break;
            }
        }
        return new ArrayList<>(out);
    }

    static String cacheName(String url) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(url.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(64);
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private void run(long my, List<String> urls) {
        if (gen.get() != my) return;
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        BlocklistParser.Sink sink = new BlocklistParser.Sink(MAX_DOMAINS);
        List<Status> sts = new ArrayList<>();
        Set<String> keep = new LinkedHashSet<>();

        for (String url : urls) {
            if (gen.get() != my) return; // 新しい呼び出しに追い越された
            String name = cacheName(url);
            keep.add(name + ".txt");
            File cache = new File(dir, name + ".txt");
            String error = null;
            long now = System.currentTimeMillis();
            long age = now - cache.lastModified();
            boolean fresh = cache.isFile() && cache.length() > 0 && age >= 0 && age < CACHE_TTL_MS;
            if (!fresh) {
                File tmp = new File(dir, name + ".tmp");
                try {
                    fetcher.fetch(url, tmp, MAX_BYTES);
                    if (!tmp.isFile() || tmp.length() == 0) throw new IOException("empty response");
                    //noinspection ResultOfMethodCallIgnored
                    cache.delete();
                    if (!tmp.renameTo(cache)) throw new IOException("cache rename failed");
                } catch (Exception e) {
                    error = describe(e);
                    //noinspection ResultOfMethodCallIgnored
                    tmp.delete();
                }
            }
            int domains = 0;
            long updatedAt = 0;
            if (cache.isFile() && cache.length() > 0) {
                updatedAt = cache.lastModified();
                int before = sink.blockAccepted;
                try (Reader r = new InputStreamReader(new BufferedInputStream(new FileInputStream(cache), 65536), StandardCharsets.UTF_8)) {
                    BlocklistParser.parse(r, sink);
                } catch (IOException e) {
                    if (error == null) error = describe(e);
                }
                domains = sink.blockAccepted - before;
                if (sink.limitReached && error == null) error = "domain limit reached";
            }
            sts.add(new Status(url, domains, updatedAt, error));
        }

        synchronized (swapLock) {
            if (gen.get() != my) return;
            matcher = sink.block.isEmpty() ? null : new DomainMatcher(sink.block, sink.allow);
            statuses = Collections.unmodifiableList(sts);
        }
        cleanup(my, keep);
    }

    /** 今回使わないキャッシュ(と残骸の .tmp)を削除する。最新世代のときだけ行う。 */
    private void cleanup(long my, Set<String> keep) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (gen.get() != my) return;
            if (!keep.contains(f.getName())) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
    }

    private static String describe(Exception e) {
        String m = e.getMessage();
        String s = e.getClass().getSimpleName() + (m == null || m.isEmpty() ? "" : ": " + m);
        return s.length() > 200 ? s.substring(0, 200) : s;
    }

    /** HttpsURLConnection でのダウンロード。https 以外はリダイレクト先でも拒否する。 */
    static final class HttpsFetcher implements Fetcher {
        private static final int MAX_REDIRECTS = 5;

        @Override
        public void fetch(String url, File dest, long maxBytes) throws IOException {
            String cur = url;
            for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
                URL u = new URL(cur);
                if (!"https".equals(u.getProtocol())) throw new IOException("non-https url");
                HttpURLConnection c = (HttpURLConnection) u.openConnection();
                try {
                    c.setInstanceFollowRedirects(false);
                    c.setConnectTimeout(10_000);
                    c.setReadTimeout(20_000);
                    c.setRequestProperty("User-Agent", "novel-backup-adblock");
                    int code = c.getResponseCode();
                    if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                        String loc = c.getHeaderField("Location");
                        if (loc == null || loc.isEmpty()) throw new IOException("redirect without location");
                        cur = new URL(u, loc).toString();
                        continue;
                    }
                    if (code != 200) throw new IOException("HTTP " + code);
                    long len = c.getContentLengthLong();
                    if (len > maxBytes) throw new IOException("too large");
                    try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
                        byte[] buf = new byte[32768];
                        long total = 0;
                        int n;
                        while ((n = in.read(buf)) != -1) {
                            total += n;
                            if (total > maxBytes) throw new IOException("too large");
                            out.write(buf, 0, n);
                        }
                    }
                    return;
                } finally {
                    c.disconnect();
                }
            }
            throw new IOException("too many redirects");
        }
    }

    /** テスト/終了用 */
    void shutdown() {
        exec.shutdownNow();
        try {
            exec.awaitTermination(1, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }
}
