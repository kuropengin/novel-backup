import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from urllib.parse import urlparse
from lxml import html
from scrapling import Fetcher


@dataclass
class Episode:
    episode_key: str
    position: int
    title: str
    chapter: str | None
    published_at: str
    updated_at: str


def first_text(tree, xpaths: list[str]) -> str:
    for xp in xpaths:
        nodes = tree.xpath(xp)
        if not nodes:
            continue
        if isinstance(nodes[0], str):
            text = nodes[0].strip()
        else:
            text = "".join(nodes[0].itertext()).strip()
        if text:
            return text
    return ""


def first_attr(tree, xpaths: list[str]) -> str:
    for xp in xpaths:
        values = tree.xpath(xp)
        for value in values:
            text = str(value).strip()
            if text:
                return text
    return ""


def _inline_text(el) -> str:
    """要素内のインラインテキストを取得する。<br> は改行、ruby は 漢字《かな》 形式にする。"""
    parts: list[str] = []

    def walk(node):
        tag = node.tag if isinstance(node.tag, str) else ""
        tag = tag.lower()
        if tag in ("script", "style", "rp"):
            return
        if tag == "br":
            parts.append("\n")
            return
        if tag == "rt":
            ruby = "".join(node.itertext()).strip()
            if ruby:
                parts.append(f"《{ruby}》")
            return
        if node.text and tag:
            parts.append(node.text)
        for child in node:
            walk(child)
            if child.tail:
                parts.append(child.tail)

    if el.text:
        parts.append(el.text)
    for child in el:
        walk(child)
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


def block_text(el) -> str:
    """本文ブロックをプレーンテキスト(改行区切り)へ変換する。
    <p> が1行ずつ入っている構造(なろう/ハーメルン/カクヨム)は 1 <p> = 1 行、
    <p> が無い場合は <br> を改行として扱う。空行 (<p><br></p>) も保持する。"""
    if el is None:
        return ""
    paragraphs = el.xpath(".//p")
    if paragraphs:
        # 1 <p> = 1 行。行内に紛れた改行は除去する
        lines = [_inline_text(p).replace("\r", "").replace("\n", "") for p in paragraphs]
    else:
        lines = _inline_text(el).replace("\r", "").split("\n")
    text = "\n".join(line.rstrip() for line in lines)
    return text.strip("\n")


def first_block(tree, xpaths: list[str]) -> str:
    """最初に見つかった非空ノードを block_text で返す"""
    for xp in xpaths:
        for node in tree.xpath(xp):
            text = block_text(node)
            if text.strip():
                return text
    return ""


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in ("0", "false", "no", "off")


def _base_fetch_kwargs() -> dict:
    kwargs: dict = {
        "stealthy_headers": _env_bool("SCRAPLING_STEALTHY_HEADERS", True),
    }
    proxy = (os.getenv("SCRAPLING_PROXY") or "").strip()
    if proxy:
        kwargs["proxy"] = proxy
    return kwargs


def get_tree(url: str):
    host = (urlparse(url).hostname or "").lower()
    base_kwargs = _base_fetch_kwargs()

    # syosetu.org は環境によって 403 になることがあるため、段階的に取得条件を変えて再試行する
    attempts = [("default", base_kwargs)]
    if host.endswith("syosetu.org"):
        attempts.extend([
            (
                "same-origin-ref",
                {
                    **base_kwargs,
                    "headers": {
                        "referer": "https://syosetu.org/",
                        "accept-language": "ja,en-US;q=0.9,en;q=0.8",
                    },
                },
            ),
            (
                "same-origin-ref-no-impersonate",
                {
                    **base_kwargs,
                    "impersonate": None,
                    "headers": {
                        "referer": "https://syosetu.org/",
                        "accept-language": "ja,en-US;q=0.9,en;q=0.8",
                    },
                },
            ),
        ])

    traces: list[str] = []
    last_error: str | None = None
    for label, kwargs in attempts:
        try:
            response = Fetcher.get(url, **kwargs)
        except Exception as exc:
            last_error = str(exc)
            traces.append(f"{label}:error")
            continue
        traces.append(f"{label}:{response.status}")
        if response.status < 400:
            return html.fromstring(response.body), str(response.url)
        last_error = f"HTTP {response.status}"

    detail = ", ".join(traces)
    if last_error:
        raise RuntimeError(f"{last_error}: {url} (attempts: {detail})")
    raise RuntimeError(f"failed to fetch: {url}")


def scrape_narou_metadata(novel_key: str):
    tree, resolved_url = get_tree(f"https://ncode.syosetu.com/{novel_key}/")
    title = first_text(tree, ["//h1[contains(@class,'novel_title')]", "//h1[contains(@class,'p-novel__title')]", "//title"])
    # modern layout: <div class="p-novel__author"><a>...</a></div>
    # old layout: <div class="novel_writername"><a>...</a></div>
    author = first_text(tree, [
        "//div[contains(@class,'p-novel__author')]//a",
        "//div[contains(@class,'novel_writername')]//a",
        "//div[contains(@class,'novel_writer')]//a",
    ])
    description = first_text(tree, ["//div[@id='novel_ex']", "//div[contains(@class,'p-novel__summary')]"])
    status = first_text(tree, ["//div[contains(@class,'novel_status')]"]) or "unknown"
    info_text = " ".join(tree.xpath("//div[contains(@class,'novel_info')]//text()"))
    match = re.search(r"(\d+)話", info_text)
    episode_count = int(match.group(1)) if match else 0
    last_updated = first_text(tree, ["//div[contains(@class,'novel_sublist2')]//span[contains(@class,'long_update')]"]) or ""
    return {
        "title": title or "Unknown",
        "author": author or "Unknown",
        "description": description,
        "status": status,
        "episodeCount": episode_count,
        "lastUpdated": last_updated,
        "url": resolved_url,
    }


def scrape_narou_episodes(novel_key: str):
    tree, _ = get_tree(f"https://ncode.syosetu.com/{novel_key}/")
    links = tree.xpath("//a[contains(@class,'subtitle')]")
    episodes: list[Episode] = []
    for idx, link in enumerate(links, 1):
        href = first_attr(link, ["./@href"])
        title = first_text(link, ["."])
        if not href or not title:
            continue
        episode_key = href.strip("/").split("/")[-1]
        row = link.getparent()
        published_at = ""
        updated_at = ""
        if row is not None:
            # 新: div.p-eplist__update に「公開日時」テキスト + <span title="... 改稿">
            # 旧: span[class*=update] の title 属性
            upd = row.xpath(".//div[contains(@class,'p-eplist__update')]")
            if upd:
                published_at = (upd[0].text or "").strip()
                updated_at = first_attr(upd[0], [".//span/@title"]).replace("改稿", "").strip()
            else:
                updated_at = first_attr(row, [".//span[contains(@class,'update')]//@title"])
        published_at = published_at or updated_at
        updated_at = updated_at or published_at
        episodes.append(
            Episode(
                episode_key=episode_key,
                position=idx,
                title=title,
                chapter=None,
                published_at=published_at,
                updated_at=updated_at,
            )
        )
    return [e.__dict__ for e in episodes]


def scrape_narou_content(novel_key: str, episode_key: str):
    tree, _ = get_tree(f"https://ncode.syosetu.com/{novel_key}/{episode_key}/")
    title = first_text(tree, [
        "//h1[contains(@class,'p-novel__title')]",  # 新マークアップ(2024+)
        "//p[contains(@class,'novel_subtitle')]",  # 旧マークアップ
    ])
    # 新マークアップ: div.js-novel-text.p-novel__text (前書き/後書きは --preface / --afterword 修飾子)
    # 旧マークアップ: #novel_p / #novel_honbun / #novel_a
    preface = first_block(tree, [
        "//div[contains(@class,'p-novel__text--preface')]",
        "//div[@id='novel_p']",
    ])
    afterword = first_block(tree, [
        "//div[contains(@class,'p-novel__text--afterword')]",
        "//div[@id='novel_a']",
    ])
    body = first_block(tree, [
        "//div[contains(@class,'js-novel-text') and contains(@class,'p-novel__text') "
        "and not(contains(@class,'p-novel__text--preface')) and not(contains(@class,'p-novel__text--afterword'))]",
        "//div[@id='novel_honbun']",
    ])
    if not body:
        # 空本文を保存すると以後「取得済み」扱いになるため、必ず失敗させる
        raise RuntimeError(f"narou body not found (markup changed?): {novel_key}/{episode_key}")
    return {
        "title": title,
        "prefaceHtml": preface or None,
        "bodyHtml": body,
        "afterwordHtml": afterword or None,
        "updatedAt": "",
    }


def scrape_hameln_metadata(novel_key: str):
    tree, resolved_url = get_tree(f"https://syosetu.org/novel/{novel_key}/")
    # タイトルは <span itemprop="name">。<title> は末尾に " - ハーメルン" が付くため最後の手段にする
    title = first_text(tree, ["//span[@itemprop='name']", "//h1", "//title"])
    title = re.sub(r"\s*-\s*ハーメルン\s*$", "", title)
    # 作者: <div align="right">作者:<span itemprop="author">名前</span></div>(リンクの場合もある)
    author = first_text(tree, [
        "//*[@itemprop='author']//a",
        "//*[@itemprop='author']",
        "//a[contains(@href,'/user/')]",
        "//div[contains(@class,'author')]//a",
        "//span[contains(@class,'author_name')]",
        "//div[contains(@class,'info')]//a[contains(@href,'/user/')]",
    ])
    description = first_text(tree, ["//div[contains(@class,'explain')]", "//div[contains(@class,'introduction')]", "//p[contains(@class,'intro')]"])
    status = first_text(tree, ["//span[contains(text(),'連載') or contains(text(),'完結')]"]) or "unknown"
    items = tree.xpath("//li[contains(@class,'episode-list__item')]")
    if items:
        episode_count = len(items)
    else:
        episode_count = len(tree.xpath("//a[contains(@href,'.html') and contains(@href,'/novel/')]"))
    return {
        "title": title or "Unknown",
        "author": author or "Unknown",
        "description": description,
        "status": status,
        "episodeCount": episode_count,
        "lastUpdated": "",
        "url": resolved_url,
    }


def scrape_hameln_episodes(novel_key: str):
    tree, _ = get_tree(f"https://syosetu.org/novel/{novel_key}/")
    episodes: list[Episode] = []
    seen: set[str] = set()

    def add(href: str, title: str, published_at: str, updated_at: str):
        m = re.search(r"(?:^|/|\.\/)(\d+)\.html$", href)
        if not m or not title:
            return
        episode_key = m.group(1)
        if episode_key in seen:
            return
        seen.add(episode_key)
        published_at = published_at or updated_at
        episodes.append(
            Episode(
                episode_key=episode_key,
                position=len(episodes) + 1,
                title=title,
                chapter=None,
                published_at=published_at,
                updated_at=updated_at or published_at,
            )
        )

    # 新マークアップ: li.episode-list__item > a > (span.episode-list__title, time.episode-list__date, span.episode-list__revision[title="... 改稿"])
    # time の datetime 属性は JST 表記に Z が付いていて信頼できないため、表示テキスト(JST)を使う
    for item in tree.xpath("//li[contains(@class,'episode-list__item')]"):
        href = first_attr(item, [".//a/@href"])
        title = first_text(item, [".//*[contains(@class,'episode-list__title')]"])
        published = first_text(item, [".//time[contains(@class,'episode-list__date')]"])
        revised = first_attr(item, [".//*[contains(@class,'episode-list__revision')]/@title"]).replace("改稿", "").strip()
        add(href, title, published, revised)
    if episodes:
        return [e.__dict__ for e in episodes]

    # 旧マークアップ: a[href$=.html] を並べただけ(日時なし)
    for link in tree.xpath("//a[contains(@href,'.html')]"):
        add(first_attr(link, ["./@href"]), first_text(link, ["."]), "", "")
    return [e.__dict__ for e in episodes]


def scrape_hameln_content(novel_key: str, episode_key: str):
    tree, _ = get_tree(f"https://syosetu.org/novel/{novel_key}/{episode_key}.html")
    title = first_text(tree, ["//title", "//h2", "//h1"])
    if " - " in title:
        parts = title.split(" - ")
        if len(parts) >= 2:
            title = parts[1]
    # 各行が <p id="N"> になっているため block_text で行ごとに改行へ変換する
    body = first_block(
        tree,
        [
            "//div[@id='honbun']",
            "//div[contains(@class,'honbun') or contains(@class,'main_text')]",
        ],
    )
    if not body:
        raise RuntimeError(f"hameln body not found: {novel_key}/{episode_key}")
    preface = first_block(tree, ["//div[@id='maegaki']"])
    afterword = first_block(tree, ["//div[@id='atogaki']"])
    return {
        "title": title,
        "prefaceHtml": preface or None,
        "bodyHtml": body,
        "afterwordHtml": afterword or None,
        "updatedAt": "",
    }


def kakuyomu_apollo_state(tree) -> dict:
    """__NEXT_DATA__ 内の Apollo キャッシュを返す(取れなければ空 dict)。"""
    raw = first_attr(tree, ["//script[@id='__NEXT_DATA__']/text()"])
    if not raw:
        return {}
    try:
        return json.loads(raw)["props"]["pageProps"]["__APOLLO_STATE__"]
    except Exception:
        return {}


def scrape_kakuyomu_metadata(novel_key: str):
    tree, resolved_url = get_tree(f"https://kakuyomu.jp/works/{novel_key}")
    state = kakuyomu_apollo_state(tree)
    work = state.get(f"Work:{novel_key}") or {}
    ref = (work.get("author") or {}).get("__ref")
    user = state.get(ref) if ref else None
    state_author = ((user or {}).get("activityName") or (user or {}).get("name") or "").strip()
    state_updated = work.get("lastEpisodePublishedAt") or ""
    title = first_text(tree, ["//h1//*[contains(@class,'title')]", "//h1", "//title"])
    # Kakuyomu author: usually <a href="/users/...">name</a>
    author = state_author or first_text(tree, [
        "//a[contains(@href,'/users/')]",
        "//span[contains(@class,'author_name')]",
        "//div[contains(@class,'author')]//a",
    ])
    description = first_text(tree, ["//p[contains(@class,'description')]", "//div[contains(@class,'description')]"])
    status = first_text(tree, ["//*[contains(text(),'連載中') or contains(text(),'完結済')]"]) or "unknown"
    links = tree.xpath("//a[contains(@href,'/episodes/')]")
    return {
        "title": title or "Unknown",
        "author": author or "Unknown",
        "description": description,
        "status": status,
        "episodeCount": len(links),
        "lastUpdated": state_updated,
        "url": resolved_url,
    }


def scrape_kakuyomu_episodes(novel_key: str):
    tree, _ = get_tree(f"https://kakuyomu.jp/works/{novel_key}")
    episodes: list[Episode] = []
    seen: set[str] = set()

    # Apollo キャッシュの目次(tableOfContentsV2 → 章 → 話)から、公開日時(ISO, UTC)付きで取得する
    state = kakuyomu_apollo_state(tree)
    work = state.get(f"Work:{novel_key}") or {}
    for chapter_ref in work.get("tableOfContentsV2") or []:
        chapter = state.get(chapter_ref.get("__ref")) or {}
        chapter_title = None
        title_ref = (chapter.get("chapter") or {}).get("__ref")
        if title_ref:
            chapter_title = (state.get(title_ref) or {}).get("title")
        for ep_ref in chapter.get("episodeUnions") or []:
            ep = state.get(ep_ref.get("__ref")) or {}
            episode_key = str(ep.get("id") or "")
            title = (ep.get("title") or "").strip()
            if not episode_key or not title or episode_key in seen:
                continue
            seen.add(episode_key)
            published = ep.get("publishedAt") or ""
            episodes.append(
                Episode(
                    episode_key=episode_key,
                    position=len(episodes) + 1,
                    title=title,
                    chapter=chapter_title,
                    published_at=published,
                    updated_at=published,
                )
            )
    if episodes:
        return [e.__dict__ for e in episodes]

    # フォールバック: HTML のリンクから(日時なし)
    links = tree.xpath("//a[contains(@href,'/episodes/')]")
    for link in links:
        href = first_attr(link, ["./@href"])
        title = first_text(link, [".//span[contains(@class,'title')]", "."])
        if not href or not title:
            continue
        episode_key = href.split("/episodes/")[-1].strip("/")
        if not episode_key or episode_key in seen:
            continue
        seen.add(episode_key)
        episodes.append(
            Episode(
                episode_key=episode_key,
                position=len(episodes) + 1,
                title=title,
                chapter=None,
                published_at="",
                updated_at="",
            )
        )
    return [e.__dict__ for e in episodes]


def scrape_kakuyomu_content(novel_key: str, episode_key: str):
    tree, _ = get_tree(f"https://kakuyomu.jp/works/{novel_key}/episodes/{episode_key}")
    title = first_text(tree, ["//h1", "//p[contains(@class,'widget-episodeTitle')]"])
    body = first_block(
        tree,
        [
            "//div[contains(@class,'widget-episodeBody')]",
            "//div[contains(@class,'episode-body')]",
            "//article",
        ],
    )
    if not body:
        raise RuntimeError(f"kakuyomu body not found: {novel_key}/{episode_key}")
    return {
        "title": title,
        "prefaceHtml": None,
        "bodyHtml": body,
        "afterwordHtml": None,
        "updatedAt": "",
    }


SELF_TEST_HTML = """<html><head><title>t</title></head><body>
<h1 class="p-novel__title">第一話</h1>
<div class="js-novel-text p-novel__text">
<p>こんにちは</p><p><br></p><p><ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>です</p>
</div>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"__APOLLO_STATE__":{"Work:1":{"id":"1"}}}}}</script>
</body></html>"""


def self_test() -> dict:
    """ネットワークなしの自己診断。Fetcher の import と、本スクリプトの抽出関数で固定 HTML を解析できることを確認する。
    更新ジョブ(pythonUpdater.ts)が、新しい scrapling を有効化する前に実行する。"""
    from importlib import metadata

    if not callable(getattr(Fetcher, "get", None)):
        raise RuntimeError("Fetcher.get is not callable")
    tree = html.fromstring(SELF_TEST_HTML)
    title = first_text(tree, ["//h1[contains(@class,'p-novel__title')]"])
    body = first_block(tree, ["//div[contains(@class,'js-novel-text')]"])
    state = kakuyomu_apollo_state(tree)
    expected_body = "こんにちは" + chr(10) * 2 + "漢字《かんじ》です"
    if title != "第一話":
        raise RuntimeError(f"title mismatch: {title!r}")
    if body != expected_body:
        raise RuntimeError(f"body mismatch: {body!r}")
    if state.get("Work:1", {}).get("id") != "1":
        raise RuntimeError("apollo state mismatch")
    return {"scrapling": metadata.version("scrapling"), "python": f"{sys.version_info.major}.{sys.version_info.minor}"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", choices=["narou", "hameln", "kakuyomu"])
    parser.add_argument("--novel-key")
    parser.add_argument("--operation", choices=["metadata", "episodes", "content"])
    parser.add_argument("--episode-key")
    parser.add_argument("--self-test", action="store_true", help="ネットワークなしの自己診断(更新ジョブ用)")
    args = parser.parse_args()

    if args.self_test:
        try:
            print(json.dumps({"ok": True, "data": self_test()}, ensure_ascii=False))
        except Exception as exc:
            print(json.dumps({"ok": False, "error": f"self-test failed: {exc}"}, ensure_ascii=False))
            sys.exit(1)
        return
    if not (args.site and args.novel_key and args.operation):
        parser.error("--site, --novel-key and --operation are required")

    dispatch = {
        "narou": {
            "metadata": scrape_narou_metadata,
            "episodes": scrape_narou_episodes,
            "content": scrape_narou_content,
        },
        "hameln": {
            "metadata": scrape_hameln_metadata,
            "episodes": scrape_hameln_episodes,
            "content": scrape_hameln_content,
        },
        "kakuyomu": {
            "metadata": scrape_kakuyomu_metadata,
            "episodes": scrape_kakuyomu_episodes,
            "content": scrape_kakuyomu_content,
        },
    }

    try:
        if args.operation == "content":
            if not args.episode_key:
                raise ValueError("episode-key is required for content operation")
            data = dispatch[args.site]["content"](args.novel_key, args.episode_key)
        else:
            data = dispatch[args.site][args.operation](args.novel_key)
        print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
