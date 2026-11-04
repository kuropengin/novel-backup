package local.novelbackup.app;

import java.io.IOException;
import java.io.Reader;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * DNS 形式ブロックリストのパーサ(Android 非依存。JUnit でテストする)。
 *
 * 対応する行(# と ! のコメント・空行は無視):
 *  - hosts 形式: "0.0.0.0 domain" / "127.0.0.1 domain" / "::1 domain"(行末コメント・複数ホスト名可)
 *  - ドメインのみの行 / ワイルドカード "*.domain"(oisd domainswild)
 *  - adblock 形式 "||domain^"(末尾 "^|" も可)。例外 "@@||domain^" は allow 集合へ
 * 推測はしない: 修飾子($...)・パス・正規表現・内部のワイルドカード・"||domain"(^ 無し)などは読み飛ばす。
 * localhost / broadcasthost / local / ip6-* / IP リテラル / ドットの無いホストは取り込まない。ホスト名は小文字化する。
 */
final class BlocklistParser {
    private BlocklistParser() {}

    /** 1 行の最大長。これを超える行は読み飛ばす(改行の無い巨大ファイル対策)。 */
    static final int MAX_LINE = 2048;

    /** 解析結果の受け皿。block/allow の合計(重複除く)が max に達したら追加を止める。 */
    static final class Sink {
        final Set<String> block = new HashSet<>();
        final Set<String> allow = new HashSet<>();
        final int max;
        /** 受理したブロック規則の数(他リストと重複していても数える。リスト別の件数表示用) */
        int blockAccepted = 0;
        boolean limitReached = false;

        Sink(int max) {
            this.max = max;
        }

        boolean full() {
            return block.size() + allow.size() >= max;
        }

        void addBlock(String host) {
            if (full()) {
                limitReached = true;
                return;
            }
            block.add(host);
            blockAccepted++;
        }

        void addAllow(String host) {
            if (full()) {
                limitReached = true;
                return;
            }
            allow.add(host);
        }
    }

    /** Reader を行単位で解析する。上限に達したら残りは読まずに戻る。 */
    static void parse(Reader reader, Sink sink) throws IOException {
        StringBuilder sb = new StringBuilder(128);
        boolean overflow = false;
        int c;
        while ((c = reader.read()) != -1) {
            if (c == '\n' || c == '\r') {
                if (!overflow && sb.length() > 0) parseLine(sb.toString(), sink);
                sb.setLength(0);
                overflow = false;
                if (sink.full()) {
                    sink.limitReached = true;
                    return;
                }
            } else if (!overflow) {
                if (sb.length() >= MAX_LINE) overflow = true;
                else sb.append((char) c);
            }
        }
        if (!overflow && sb.length() > 0) parseLine(sb.toString(), sink);
    }

    static void parseLine(String raw, Sink sink) {
        String line = raw.trim();
        if (line.isEmpty()) return;
        char first = line.charAt(0);
        if (first == '#' || first == '!' || first == '[') return;

        if (line.startsWith("@@")) {
            String h = adblockHost(line.substring(2));
            if (h != null) sink.addAllow(h);
            return;
        }
        if (line.startsWith("||")) {
            String h = adblockHost(line);
            if (h != null) sink.addBlock(h);
            return;
        }

        // 行末コメント: '#' が行頭または空白の直後のときだけコメント("example.com##.ad" のような要素隠蔽規則は取り込まない)
        for (int i = 1; i < line.length(); i++) {
            if (line.charAt(i) == '#' && Character.isWhitespace(line.charAt(i - 1))) {
                line = line.substring(0, i).trim();
                break;
            }
        }
        if (line.isEmpty()) return;

        String[] tok = line.split("\\s+");
        if (tok.length == 1) {
            String t = tok[0];
            if (t.startsWith("*.")) t = t.substring(2);
            String h = normalizeHost(t);
            if (h != null) sink.addBlock(h);
        } else if (isSinkAddress(tok[0])) {
            for (int i = 1; i < tok.length; i++) {
                String h = normalizeHost(tok[i]);
                if (h != null) sink.addBlock(h);
            }
        }
    }

    private static boolean isSinkAddress(String s) {
        return "0.0.0.0".equals(s) || "127.0.0.1".equals(s) || "::1".equals(s) || "::".equals(s);
    }

    /** "||host^" または "||host^|" のホスト部。修飾子・パス・ワイルドカード等を含むなら null。 */
    private static String adblockHost(String rule) {
        if (!rule.startsWith("||")) return null;
        String body = rule.substring(2);
        if (body.endsWith("^|")) body = body.substring(0, body.length() - 2);
        else if (body.endsWith("^")) body = body.substring(0, body.length() - 1);
        else return null;
        return normalizeHost(body);
    }

    /** 取り込める正規のホスト名なら小文字にして返す。そうでなければ null。 */
    static String normalizeHost(String s) {
        int n = s.length();
        if (n < 3 || n > 253) return null;
        String h = s.toLowerCase(Locale.ROOT);
        boolean dot = false;
        for (int i = 0; i < n; i++) {
            char c = h.charAt(i);
            if (c == '.') {
                // 先頭/末尾/連続のドットは不可
                if (i == 0 || i == n - 1 || h.charAt(i - 1) == '.') return null;
                dot = true;
            } else if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) {
                return null;
            }
        }
        if (!dot) return null;
        // 最後のラベルが全部数字 = IPv4 リテラル(または数字だけの TLD)
        String tld = h.substring(h.lastIndexOf('.') + 1);
        boolean allDigits = true;
        for (int i = 0; i < tld.length(); i++) {
            if (tld.charAt(i) < '0' || tld.charAt(i) > '9') {
                allDigits = false;
                break;
            }
        }
        if (allDigits) return null;
        if (h.equals("localhost") || h.startsWith("localhost.") || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".localdomain")) return null;
        if (h.equals("broadcasthost") || h.equals("local") || h.startsWith("ip6-")) return null;
        return h;
    }
}
