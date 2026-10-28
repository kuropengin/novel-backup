package local.novelbackup.app;

import android.animation.ValueAnimator;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.DecelerateInterpolator;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.Locale;

/**
 * SiteView: Capacitor のブリッジ WebView(アプリ UI)の上に、ネイティブ WebView(サイト表示用)を矩形で重ねる。
 *
 * 座標系: JS から渡す top / bottom は「ブリッジ WebView の上端/下端からの距離」を CSS px で表したもの。
 * WebView の CSS px は dp と等しいので、density を掛けて物理 px にする。
 * ブリッジ WebView の画面上の位置を実測して基準にするため、Capacitor の edge-to-edge 処理(マージン付与の有無)に依存しない。
 * さらに、システムバー/ディスプレイカットアウトの下には潜らないようクランプする。
 *
 * 全ての View 操作は UI スレッドで行う。UA は変更しない(既定のまま)。
 */
@CapacitorPlugin(name = "SiteView")
public class SiteViewPlugin extends Plugin {

    /**
     * アプリ内で開いてよいホスト(サブドメイン含む)。唯一の許可リスト。これ以外へは遷移せず、
     * externalLink イベントで JS に通知する(確認後に openExternal で既定ブラウザへ)。
     * 注意: TS 側 src/logic/sites.ts の ALLOWED_HOST_SUFFIXES / isAllowedHost / isInAppUrl と必ず一致させること。
     */
    private static final String[] ALLOWED_HOST_SUFFIXES = {"syosetu.org", "syosetu.com", "kakuyomu.jp"};
    private static final long ANIM_MS = 200;
    /** SPA 遷移(pushState)で合成する pageFinished の遅延。タイトル更新を待つ。 */
    private static final long SPA_DELAY_MS = 400;

    private final Handler main = new Handler(Looper.getMainLooper());

    private WebView webView;
    private ViewGroup container;
    private View bridgeView;
    private boolean visible = true;
    private boolean loading = false;
    private String lastFinishedUrl = "";
    /** 現在適用中のインセット(CSS px = dp)。アニメーション中は中間値。 */
    private float curTop, curBottom;
    private ValueAnimator animator;
    private View.OnLayoutChangeListener layoutListener;
    private int[] lastMargins = new int[]{-1, -1, -1, -1};

    // ------------------------------------------------------------------ plugin methods

    @PluginMethod
    public void open(PluginCall call) {
        final String url = call.getString("url");
        if (!isNavigableUrl(url)) {
            call.reject("url is not allowed");
            return;
        }
        final float top = floatOf(call, "top");
        final float bottom = floatOf(call, "bottom");
        onUi(call, () -> {
            if (webView == null) createWebView();
            stopAnimation();
            curTop = top;
            curBottom = bottom;
            visible = true;
            webView.setVisibility(View.VISIBLE);
            webView.onResume();
            applyRect();
            loading = true;
            webView.loadUrl(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        onUi(call, () -> {
            destroyWebView();
            call.resolve();
        });
    }

    @PluginMethod
    public void setVisible(PluginCall call) {
        final boolean v = Boolean.TRUE.equals(call.getBoolean("visible", true));
        onUi(call, () -> {
            visible = v;
            if (webView != null) {
                webView.setVisibility(v ? View.VISIBLE : View.GONE);
                if (v) webView.onResume();
                else webView.onPause();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setInsets(PluginCall call) {
        final float top = floatOf(call, "top");
        final float bottom = floatOf(call, "bottom");
        final boolean animate = Boolean.TRUE.equals(call.getBoolean("animate", false));
        onUi(call, () -> {
            stopAnimation();
            if (webView == null || !animate) {
                curTop = top;
                curBottom = bottom;
                applyRect();
            } else {
                final float fromTop = curTop, fromBottom = curBottom;
                animator = ValueAnimator.ofFloat(0f, 1f);
                animator.setDuration(ANIM_MS);
                animator.setInterpolator(new DecelerateInterpolator());
                animator.addUpdateListener(a -> {
                    float f = (float) a.getAnimatedValue();
                    curTop = fromTop + (top - fromTop) * f;
                    curBottom = fromBottom + (bottom - fromBottom) * f;
                    applyRect();
                });
                animator.start();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void navigate(PluginCall call) {
        final String url = call.getString("url");
        if (!isNavigableUrl(url)) {
            call.reject("url is not allowed");
            return;
        }
        onUi(call, () -> {
            if (webView == null) {
                call.reject("not open");
                return;
            }
            loading = true;
            webView.loadUrl(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void goBack(PluginCall call) {
        onUi(call, () -> {
            boolean went = false;
            if (webView != null && webView.canGoBack()) {
                webView.goBack();
                went = true;
            }
            JSObject r = new JSObject();
            r.put("wentBack", went);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void reload(PluginCall call) {
        onUi(call, () -> {
            if (webView != null) webView.reload();
            call.resolve();
        });
    }

    /** 既定ブラウザ等で URL を開く。http/https/mailto/tel のみ許可(intent: や javascript: は拒否)。 */
    @PluginMethod
    public void openExternal(PluginCall call) {
        final String url = call.getString("url");
        if (url == null) {
            call.reject("url is required");
            return;
        }
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!("http".equals(scheme) || "https".equals(scheme) || "mailto".equals(scheme) || "tel".equals(scheme))) {
            call.reject("scheme is not allowed");
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, uri);
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("このリンクを開けるアプリがありません");
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()), e);
        }
    }

    @PluginMethod
    public void getState(PluginCall call) {
        onUi(call, () -> call.resolve(state()));
    }

    /** JS を評価し、評価結果の JSON 文字列を result に入れて返す(式が undefined なら "null")。 */
    @PluginMethod
    public void evaluate(PluginCall call) {
        final String code = call.getString("code");
        if (code == null) {
            call.reject("code is required");
            return;
        }
        onUi(call, () -> {
            if (webView == null) {
                call.reject("not open");
                return;
            }
            webView.evaluateJavascript(code, value -> {
                JSObject r = new JSObject();
                r.put("result", value == null ? "null" : value);
                call.resolve(r);
            });
        });
    }

    /** CSS を style 要素(id=__nb_style)として挿入する。既にあれば内容を置き換える。 */
    @PluginMethod
    public void insertCss(PluginCall call) {
        final String code = call.getString("code");
        if (code == null) {
            call.reject("code is required");
            return;
        }
        onUi(call, () -> {
            if (webView == null) {
                call.reject("not open");
                return;
            }
            String js = "(function(){var id='__nb_style';var s=document.getElementById(id);"
                    + "if(!s){s=document.createElement('style');s.id=id;(document.head||document.documentElement).appendChild(s);}"
                    + "s.textContent=" + JSONObject.quote(code) + ";})();";
            webView.evaluateJavascript(js, null);
            call.resolve();
        });
    }

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void handleOnPause() {
        if (webView != null) webView.onPause();
    }

    @Override
    protected void handleOnResume() {
        if (webView != null && visible) webView.onResume();
    }

    @Override
    protected void handleOnDestroy() {
        destroyWebView();
    }

    // ------------------------------------------------------------------ internals

    /** 呼び出しを UI スレッドで実行し、例外は reject にする。 */
    private void onUi(PluginCall call, Runnable r) {
        getActivity().runOnUiThread(() -> {
            try {
                r.run();
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), e);
            }
        });
    }

    private static float floatOf(PluginCall call, String key) {
        Double d = call.getDouble(key, 0.0);
        return d == null ? 0f : Math.max(0f, d.floatValue());
    }

    private JSObject state() {
        JSObject s = new JSObject();
        s.put("open", webView != null);
        s.put("url", webView != null && webView.getUrl() != null ? webView.getUrl() : "");
        s.put("title", webView != null && webView.getTitle() != null ? webView.getTitle() : "");
        s.put("canGoBack", webView != null && webView.canGoBack());
        return s;
    }

    private void emitPage(String event, String url) {
        JSObject d = new JSObject();
        d.put("url", url == null ? "" : url);
        d.put("title", webView != null && webView.getTitle() != null ? webView.getTitle() : "");
        d.put("canGoBack", webView != null && webView.canGoBack());
        notifyListeners(event, d);
    }

    private static boolean isAllowedHost(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        for (String suffix : ALLOWED_HOST_SUFFIXES) {
            if (h.equals(suffix) || h.endsWith("." + suffix)) return true;
        }
        return false;
    }

    /** アプリから直接渡される URL は http(s) かつ許可ホストのみ。 */
    private static boolean isNavigableUrl(String url) {
        if (url == null) return false;
        Uri u = Uri.parse(url);
        String scheme = u.getScheme();
        return ("http".equals(scheme) || "https".equals(scheme)) && isAllowedHost(u.getHost());
    }

    /** 許可外 URL を JS に通知する(自動では何も開かない)。 */
    private void emitExternal(String url) {
        JSObject d = new JSObject();
        d.put("url", url == null ? "" : url);
        notifyListeners("externalLink", d);
    }

    /** 許可ホストの http(s)、または about/data/blob(ページ内部)なら true。TS の isInAppUrl と一致させる。 */
    private static boolean isInAppUrl(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if ("http".equals(scheme) || "https".equals(scheme)) return isAllowedHost(uri.getHost());
        return "about".equals(scheme) || "data".equals(scheme) || "blob".equals(scheme);
    }

    private void createWebView() {
        container = getActivity().findViewById(android.R.id.content);
        bridgeView = getBridge().getWebView();
        webView = new WebView(getActivity());
        webView.setBackgroundColor(0xFFFFFFFF);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        // window.open / target=_blank は新規ウィンドウを作らず、同じ WebView で開く(supportMultipleWindows=false)
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        // UA は変更しない(setUserAgentString は呼ばない)

        // ログイン・Cloudflare 通過状態を保持するため Cookie は永続、サードパーティも許可(この WebView のみ)
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new SiteClient());
        webView.setOnScrollChangeListener((v, sx, sy, ox, oy) -> {
            int dyPx = sy - oy;
            if (dyPx == 0) return;
            float density = v.getResources().getDisplayMetrics().density;
            JSObject d = new JSObject();
            d.put("y", Math.round(sy / density));
            d.put("dy", Math.round(dyPx / density));
            notifyListeners("scroll", d);
        });

        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        container.addView(webView, lp); // 最後に追加 = ブリッジ WebView の手前に描画される

        // 回転・キーボード・インセット変化でブリッジ WebView の位置が変わったら追従
        layoutListener = (v, l, t, r, b, ol, ot, or, ob) -> applyRect();
        container.addOnLayoutChangeListener(layoutListener);
        bridgeView.addOnLayoutChangeListener(layoutListener);
        lastMargins = new int[]{-1, -1, -1, -1};
    }

    private void destroyWebView() {
        stopAnimation();
        if (webView == null) return;
        if (container != null && layoutListener != null) container.removeOnLayoutChangeListener(layoutListener);
        if (bridgeView != null && layoutListener != null) bridgeView.removeOnLayoutChangeListener(layoutListener);
        layoutListener = null;
        webView.setWebViewClient(new WebViewClient());
        webView.setOnScrollChangeListener(null);
        webView.stopLoading();
        if (webView.getParent() instanceof ViewGroup) ((ViewGroup) webView.getParent()).removeView(webView);
        webView.destroy();
        webView = null;
        loading = false;
        lastFinishedUrl = "";
        CookieManager.getInstance().flush(); // Cookie をディスクへ確実に保存
    }

    private void stopAnimation() {
        if (animator != null) {
            animator.cancel();
            animator = null;
        }
    }

    /**
     * ブリッジ WebView の実測位置 + (curTop, curBottom) dp を基準に、オーバーレイのマージンを設定する。
     * システムバー/カットアウトの下にはみ出さないようクランプ。値が変わらなければ何もしない(レイアウトループ防止)。
     */
    private void applyRect() {
        if (webView == null || container == null || bridgeView == null) return;
        float density = container.getResources().getDisplayMetrics().density;
        int topPx = Math.round(curTop * density);
        int bottomPx = Math.round(curBottom * density);

        int cw = container.getWidth(), ch = container.getHeight();
        int left = 0, top, right = 0, bottom; // コンテナ端からのマージン
        if (cw > 0 && ch > 0 && bridgeView.getWidth() > 0 && bridgeView.getHeight() > 0) {
            int[] bl = new int[2], cl = new int[2];
            bridgeView.getLocationInWindow(bl);
            container.getLocationInWindow(cl);
            int bx = bl[0] - cl[0], by = bl[1] - cl[1];
            left = Math.max(0, bx);
            right = Math.max(0, cw - (bx + bridgeView.getWidth()));
            top = Math.max(0, by) + topPx;
            bottom = Math.max(0, ch - (by + bridgeView.getHeight())) + bottomPx;
        } else {
            top = topPx;
            bottom = bottomPx;
        }

        // システムバー(ステータス/ナビゲーション)と切り欠きの内側に収める
        WindowInsetsCompat wi = ViewCompat.getRootWindowInsets(container);
        if (wi != null && cw > 0 && ch > 0) {
            Insets sb = wi.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            int[] cl = new int[2];
            container.getLocationInWindow(cl);
            int rootH = container.getRootView().getHeight();
            int rootW = container.getRootView().getWidth();
            top = Math.max(top, sb.top - cl[1]);
            bottom = Math.max(bottom, (cl[1] + ch) - (rootH - sb.bottom));
            left = Math.max(left, sb.left - cl[0]);
            right = Math.max(right, (cl[0] + cw) - (rootW - sb.right));
        }

        if (top == lastMargins[0] && bottom == lastMargins[1] && left == lastMargins[2] && right == lastMargins[3]) return;
        lastMargins = new int[]{top, bottom, left, right};
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) webView.getLayoutParams();
        lp.setMargins(left, top, right, bottom);
        webView.setLayoutParams(lp);
    }

    private class SiteClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // サブフレーム(Cloudflare チャレンジ iframe 等)は触らない
            if (!request.isForMainFrame()) return false;
            Uri uri = request.getUrl();
            if (isInAppUrl(uri)) return false;
            // リダイレクト・window.open・target=_blank もここを通る。遷移を止めて通知のみ(自動では開かない)
            emitExternal(uri.toString());
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            // 保険: 許可外ホストがここまで来たら読み込みを止め、戻れれば戻り、通知する
            if (url != null && !isInAppUrl(Uri.parse(url))) {
                view.stopLoading();
                if (view.canGoBack()) view.goBack();
                loading = false;
                emitExternal(url);
                return;
            }
            loading = true;
            emitPage("pageStarted", url);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            loading = false;
            lastFinishedUrl = url == null ? "" : url;
            emitPage("pageFinished", url);
        }

        /**
         * SPA(カクヨム等)の pushState 遷移では onPageStarted/Finished が来ない。ここで検知し、
         * 通常ロード中でなければ pageFinished(spa:true)を合成して送る(タイトル更新を待つため遅延)。
         */
        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            if (loading || url == null || url.equals(lastFinishedUrl)) return;
            lastFinishedUrl = url;
            final String u = url;
            main.postDelayed(() -> {
                if (webView == null || loading) return;
                JSObject d = new JSObject();
                d.put("url", webView.getUrl() != null ? webView.getUrl() : u);
                d.put("title", webView.getTitle() != null ? webView.getTitle() : "");
                d.put("canGoBack", webView.canGoBack());
                d.put("spa", true);
                notifyListeners("pageFinished", d);
            }, SPA_DELAY_MS);
        }
    }
}
