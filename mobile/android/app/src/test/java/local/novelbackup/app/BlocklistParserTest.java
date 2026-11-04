package local.novelbackup.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.io.StringReader;

import org.junit.Test;

public class BlocklistParserTest {

    private static BlocklistParser.Sink parse(String text) throws IOException {
        BlocklistParser.Sink s = new BlocklistParser.Sink(500_000);
        BlocklistParser.parse(new StringReader(text), s);
        return s;
    }

    private static DomainMatcher matcher(String text) throws IOException {
        BlocklistParser.Sink s = parse(text);
        return new DomainMatcher(s.block, s.allow);
    }

    @Test
    public void hostsFormat() throws IOException {
        BlocklistParser.Sink s = parse(
                "# comment\n"
                        + "\n"
                        + "127.0.0.1 localhost\n"
                        + "127.0.0.1 localhost.localdomain\n"
                        + "127.0.0.1 local\n"
                        + "255.255.255.255 broadcasthost\n"
                        + "::1 localhost\n"
                        + "::1 ip6-localhost\n"
                        + "fe80::1%lo0 localhost\n"
                        + "0.0.0.0 0.0.0.0\n"
                        + "0.0.0.0 Ads.Example.com # trailing comment\n"
                        + "127.0.0.1 tracker.example.net\n"
                        + "::1 v6.example.org\n"
                        + "0.0.0.0 a1.example.com a2.example.com\r\n"
                        + "0.0.0.0   spaced.example.com\t\n");
        assertEquals(6, s.block.size());
        assertTrue(s.block.contains("ads.example.com"));
        assertTrue(s.block.contains("tracker.example.net"));
        assertTrue(s.block.contains("v6.example.org"));
        assertTrue(s.block.contains("a1.example.com"));
        assertTrue(s.block.contains("a2.example.com"));
        assertTrue(s.block.contains("spaced.example.com"));
        assertTrue(s.allow.isEmpty());
    }

    @Test
    public void hostsWithOtherAddressesAreSkipped() throws IOException {
        BlocklistParser.Sink s = parse("192.168.1.1 router.example.com\nff02::1 ip6-allnodes\n");
        assertTrue(s.block.isEmpty());
    }

    @Test
    public void plainAndWildcardDomains() throws IOException {
        BlocklistParser.Sink s = parse(
                "# oisd small\n"
                        + "*.doubleclick.example\n"
                        + "*.000491b06a.com\n"
                        + "plain.example.com\n"
                        + "UPPER.Example.COM\n"
                        + "plain2.example.com # c\n"
                        + "nodot\n"
                        + "*.tld\n");
        assertTrue(s.block.contains("doubleclick.example"));
        assertTrue(s.block.contains("000491b06a.com"));
        assertTrue(s.block.contains("plain.example.com"));
        assertTrue(s.block.contains("upper.example.com"));
        assertTrue(s.block.contains("plain2.example.com"));
        assertEquals(5, s.block.size());
    }

    @Test
    public void adblockRulesAndExceptions() throws IOException {
        BlocklistParser.Sink s = parse(
                "! Title: AdGuard DNS filter\n"
                        + "[Adblock Plus 2.0]\n"
                        + "||pagead2.googlesyndication.com^\n"
                        + "||clarity.ms^|\n"
                        + "@@||ad.10010.com^\n"
                        + "@@||spartaindependent.com^|\n");
        assertTrue(s.block.contains("pagead2.googlesyndication.com"));
        assertTrue(s.block.contains("clarity.ms"));
        assertEquals(2, s.block.size());
        assertTrue(s.allow.contains("ad.10010.com"));
        assertTrue(s.allow.contains("spartaindependent.com"));
        assertEquals(2, s.allow.size());
    }

    @Test
    public void unsupportedRulesAreSkipped() throws IOException {
        BlocklistParser.Sink s = parse(
                "||adsrvmedia.adk2.co^$important\n"
                        + "||tn.porngo.xxx^$badfilter\n"
                        + "||example.com/ads/banner^\n"
                        + "||direct-specific.com\n"
                        + "||fxhpaoxqyajvmdg.\n"
                        + "||*.exaapi.com^\n"
                        + "||st-n.ads*-adnow.com^\n"
                        + "||reachableads-av.*.amazonaws.com^\n"
                        + "@@||example.org^$important\n"
                        + "@@/\\.(gif|jpe?g|png|webp)#(\\/?.+)?(\\/(ad)s?\\/|\\/ad-)/\n"
                        + "/^88\\.208\\.22\\.[1234]$/\n"
                        + "/^139\\.45\\.197\\.2(4[0-9]|5[0-4]):/\n"
                        + ".bbelements.com^\n"
                        + "://example.net^\n"
                        + "|foo.example.com^\n"
                        + "example.com##.ad-banner\n"
                        + "example.com#@#.ad-banner\n"
                        + "||example.com:8080^\n");
        assertTrue("block=" + s.block, s.block.isEmpty());
        assertTrue("allow=" + s.allow, s.allow.isEmpty());
    }

    @Test
    public void ipLiteralsAndSpecialHostsAreSkipped() throws IOException {
        BlocklistParser.Sink s = parse(
                "0.0.0.0\n"
                        + "1.2.3.4\n"
                        + "0.0.0.0 1.2.3.4\n"
                        + "||1.2.3.4^\n"
                        + "localhost\n"
                        + "broadcasthost\n"
                        + "ip6-loopback\n"
                        + "printer.local\n"
                        + "foo.localhost\n"
                        + "-bad-.example.com.\n"
                        + "a..b.com\n"
                        + ".lead.com\n");
        assertTrue("block=" + s.block, s.block.isEmpty());
    }

    @Test
    public void normalizeHost() {
        assertEquals("a.b.com", BlocklistParser.normalizeHost("A.B.com"));
        assertNull(BlocklistParser.normalizeHost("a.b.com/"));
        assertNull(BlocklistParser.normalizeHost("a b.com"));
        assertNull(BlocklistParser.normalizeHost("a*.com"));
    }

    @Test
    public void overlongLineIsSkippedAndNextLineStillParsed() throws IOException {
        StringBuilder sb = new StringBuilder("0.0.0.0 ");
        for (int i = 0; i < BlocklistParser.MAX_LINE + 10; i++) sb.append('a');
        sb.append(".com\nok.example.com\n");
        BlocklistParser.Sink s = parse(sb.toString());
        assertEquals(1, s.block.size());
        assertTrue(s.block.contains("ok.example.com"));
    }

    @Test
    public void domainLimitStopsParsing() throws IOException {
        BlocklistParser.Sink s = new BlocklistParser.Sink(3);
        BlocklistParser.parse(new StringReader("a1.com\na2.com\na3.com\na4.com\na5.com\n"), s);
        assertEquals(3, s.block.size());
        assertTrue(s.limitReached);
    }

    // ---- DomainMatcher

    @Test
    public void matchesExactAndParentDomains() throws IOException {
        DomainMatcher m = matcher("||ads.example.com^\n0.0.0.0 tracker.net\n");
        assertTrue(m.isBlocked("ads.example.com"));
        assertTrue(m.isBlocked("a.b.ads.example.com"));
        assertTrue(m.isBlocked("ADS.Example.COM"));
        assertTrue(m.isBlocked("ads.example.com."));
        assertTrue(m.isBlocked("x.tracker.net"));
        assertFalse(m.isBlocked("example.com"));
        assertFalse(m.isBlocked("www.example.com"));
        assertFalse(m.isBlocked("notads.example.com"));
        assertFalse(m.isBlocked("ads.example.com.evil.org"));
        assertFalse(m.isBlocked(null));
        assertFalse(m.isBlocked(""));
    }

    @Test
    public void parentMatchStopsBeforeBareTld() throws IOException {
        // 裸の TLD は candidate にしない(ここでは "com" がブロック集合にあっても全 .com を巻き込まない)
        BlocklistParser.Sink s = new BlocklistParser.Sink(10);
        s.block.add("com");
        DomainMatcher m = new DomainMatcher(s.block, s.allow);
        assertFalse(m.isBlocked("example.com"));
        assertFalse(m.isBlocked("com"));
    }

    @Test
    public void parentDomainBlockCoversSubdomains() throws IOException {
        DomainMatcher m = matcher("||example.com^\n");
        assertTrue(m.isBlocked("a.b.example.com"));
        assertTrue(m.isBlocked("example.com"));
    }

    @Test
    public void exceptionWinsOverBlock() throws IOException {
        DomainMatcher m = matcher("||example.com^\n@@||good.example.com^\n");
        assertTrue(m.isBlocked("ads.example.com"));
        assertFalse(m.isBlocked("good.example.com"));
        assertFalse(m.isBlocked("x.good.example.com"));
        // 親ドメインの例外は子ドメインのブロックにも勝つ
        DomainMatcher m2 = matcher("||ads.example.com^\n@@||example.com^\n");
        assertFalse(m2.isBlocked("ads.example.com"));
    }
}
