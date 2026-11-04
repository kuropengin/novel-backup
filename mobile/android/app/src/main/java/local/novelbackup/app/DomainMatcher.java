package local.novelbackup.app;

import java.util.Locale;
import java.util.Set;

/**
 * ホスト名のブロック判定(Android 非依存)。完全一致と、すべての親ドメイン(最後のドット 1 つ分、つまり裸の TLD の手前まで)を
 * HashSet で引く。allow 集合(例外規則)にどれか 1 つでも一致すればブロックしない(allow が優先)。
 * 例: a.b.ads.example.com → a.b.ads.example.com, b.ads.example.com, ads.example.com, example.com
 */
final class DomainMatcher {
    private final Set<String> block;
    private final Set<String> allow;

    DomainMatcher(Set<String> block, Set<String> allow) {
        this.block = block;
        this.allow = allow;
    }

    int size() {
        return block.size() + allow.size();
    }

    boolean isBlocked(String host) {
        if (host == null || host.isEmpty()) return false;
        String h = host.toLowerCase(Locale.ROOT);
        if (h.endsWith(".")) h = h.substring(0, h.length() - 1);
        boolean blocked = false;
        int start = 0;
        while (true) {
            int dot = h.indexOf('.', start);
            if (dot < 0) break; // 残りが裸の TLD(ドット無し)になるので打ち切り
            String cand = start == 0 ? h : h.substring(start);
            if (allow.contains(cand)) return false;
            if (!blocked && block.contains(cand)) blocked = true;
            start = dot + 1;
        }
        return blocked;
    }
}
