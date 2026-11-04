package local.novelbackup.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class BlocklistManagerTest {
    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private File dir;
    private BlocklistManager mgr;
    private final Map<String, String> bodies = new HashMap<>();
    private final AtomicInteger fetchCount = new AtomicInteger();
    private volatile CountDownLatch gate = null;

    private final BlocklistManager.Fetcher fake = (url, dest, max) -> {
        fetchCount.incrementAndGet();
        CountDownLatch g = gate;
        if (g != null) {
            try {
                g.await(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                throw new IOException("interrupted");
            }
        }
        String body = bodies.get(url);
        if (body == null) throw new IOException("HTTP 404");
        try (FileOutputStream o = new FileOutputStream(dest)) {
            o.write(body.getBytes(StandardCharsets.UTF_8));
        }
    };

    private static final String A = "https://a.example/list.txt";
    private static final String B = "https://b.example/list.txt";

    @Before
    public void setUp() throws IOException {
        dir = new File(tmp.newFolder(), "blocklists");
        mgr = new BlocklistManager(dir, fake);
        bodies.put(A, "0.0.0.0 ads.a.com\n0.0.0.0 t.a.com\n");
        bodies.put(B, "||b-ads.com^\n@@||ok.b-ads.com^\n");
    }

    @After
    public void tearDown() {
        mgr.shutdown();
    }

    private void applyAndWait(String... urls) throws InterruptedException {
        mgr.apply(Arrays.asList(urls));
        assertTrue(mgr.awaitIdle(5000));
    }

    @Test
    public void downloadsParsesAndSwaps() throws Exception {
        assertNull(mgr.matcher());
        applyAndWait(A, B);
        assertNotNull(mgr.matcher());
        assertTrue(mgr.matcher().isBlocked("ads.a.com"));
        assertTrue(mgr.matcher().isBlocked("x.b-ads.com"));
        assertFalse(mgr.matcher().isBlocked("ok.b-ads.com"));
        List<BlocklistManager.Status> st = mgr.statuses();
        assertEquals(2, st.size());
        assertEquals(2, st.get(0).domains);
        assertNull(st.get(0).error);
        assertTrue(st.get(0).updatedAt > 0);
        assertEquals(1, st.get(1).domains);
    }

    @Test
    public void freshCacheIsNotRedownloaded() throws Exception {
        applyAndWait(A);
        assertEquals(1, fetchCount.get());
        applyAndWait(A);
        assertEquals(1, fetchCount.get());
        assertTrue(mgr.matcher().isBlocked("ads.a.com"));
    }

    @Test
    public void staleCacheIsRedownloadedAndFallsBackOnFailure() throws Exception {
        applyAndWait(A);
        File cache = new File(dir, BlocklistManager.cacheName(A) + ".txt");
        assertTrue(cache.setLastModified(System.currentTimeMillis() - BlocklistManager.CACHE_TTL_MS - 60_000));
        applyAndWait(A);
        assertEquals(2, fetchCount.get());

        // 古いキャッシュ + 取得失敗 → キャッシュで動き、error が付く
        assertTrue(cache.setLastModified(System.currentTimeMillis() - BlocklistManager.CACHE_TTL_MS - 60_000));
        bodies.remove(A);
        applyAndWait(A);
        assertEquals(3, fetchCount.get());
        assertTrue(mgr.matcher().isBlocked("ads.a.com"));
        BlocklistManager.Status st = mgr.statuses().get(0);
        assertEquals(2, st.domains);
        assertNotNull(st.error);
    }

    @Test
    public void failureWithoutCacheContributesNothing() throws Exception {
        applyAndWait("https://missing.example/x.txt", A);
        assertTrue(mgr.matcher().isBlocked("ads.a.com"));
        BlocklistManager.Status st = mgr.statuses().get(0);
        assertEquals(0, st.domains);
        assertEquals(0, st.updatedAt);
        assertNotNull(st.error);
        assertNull(mgr.statuses().get(1).error);
    }

    @Test
    public void emptyArrayClearsImmediatelyAndRemovesCache() throws Exception {
        applyAndWait(A, B);
        assertNotNull(mgr.matcher());
        mgr.apply(Collections.<String>emptyList());
        assertNull(mgr.matcher()); // 即時
        assertTrue(mgr.awaitIdle(5000));
        assertTrue(mgr.statuses().isEmpty());
        String[] left = dir.list();
        assertEquals(0, left == null ? 0 : left.length);
    }

    @Test
    public void unusedCacheFilesAreRemoved() throws Exception {
        applyAndWait(A, B);
        assertEquals(2, dir.list().length);
        applyAndWait(B);
        String[] files = dir.list();
        assertEquals(1, files.length);
        assertEquals(BlocklistManager.cacheName(B) + ".txt", files[0]);
        assertFalse(mgr.matcher().isBlocked("ads.a.com"));
    }

    @Test
    public void supersededCallDoesNotOverwriteNewerResult() throws Exception {
        gate = new CountDownLatch(1);
        mgr.apply(Arrays.asList(A)); // 取得中に止まる
        Thread.sleep(100);
        mgr.apply(Arrays.asList(B)); // 追い越す
        gate.countDown();
        assertTrue(mgr.awaitIdle(5000));
        assertTrue(mgr.matcher().isBlocked("x.b-ads.com"));
        assertFalse(mgr.matcher().isBlocked("ads.a.com"));
        assertEquals(B, mgr.statuses().get(0).url);
    }

    @Test
    public void emptyCallSupersedesInFlightDownload() throws Exception {
        gate = new CountDownLatch(1);
        mgr.apply(Arrays.asList(A));
        Thread.sleep(100);
        mgr.apply(Collections.<String>emptyList());
        gate.countDown();
        assertTrue(mgr.awaitIdle(5000));
        assertNull(mgr.matcher());
    }

    @Test
    public void sanitizeKeepsOnlyHttpsAndDedupes() {
        List<String> out = BlocklistManager.sanitize(Arrays.asList(
                A, A, "http://insecure.example/x", "ftp://x.example/y", "not a url", "", null, "https:///nohost", " " + B + " "));
        assertEquals(Arrays.asList(A, B), out);
    }
}
