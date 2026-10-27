# 05. バックアップとバージョン管理

## 設定(`settings` テーブル、admin が UI から変更)

| key | 型 | 既定 | 説明 |
|-----|----|------|------|
| `backupIntervalMinutes` | number | 360 | 定期実行間隔。`0` で定期実行無効。有効時の最小 30 |
| `backupStartAt` | string `HH:mm` \| null | null | 指定時はその時刻を基準に間隔で回す(例 03:00 + 360 分 → 3,9,15,21 時)。null なら前回終了基準 |
| `requestIntervalMs` | number | 1500 | 同一ホストへの最小リクエスト間隔(下限 1000) |
| `fullRecheckEveryRuns` | number | 0 | N 回に 1 回、更新日時に関わらず全話本文を再取得してハッシュ比較(0=しない) |
| `maxEpisodesPerNovelPerRun` | number | 0 | 1 回の実行で 1 作品あたり取得する本文の上限(0=無制限)。大長編の初回取得を分割するため |

`PUT /api/settings` は zod で検証し、保存後に `scheduler.reschedule()`。

## Scheduler (`backup/scheduler.ts`)

- シングルトン。`setTimeout` で次回実行を予約(`nextRunAt` を保持して API で返す)。
- 実行中フラグによる **多重実行防止**。実行中に手動実行要求が来たら「実行中」と返す。
- 作品単位のキュー:`enqueue(novelId, trigger)`。ブックマーク追加時・作品個別実行はこのキューに入り、定期実行とは独立に順次処理される(同じ作品の重複投入は無視)。
- 定期実行:`SELECT DISTINCT novel_id FROM bookmarks` の全作品を `last_checked_at` 昇順で処理。
- 各実行は `backup_runs` に 1 行記録(作品個別実行も `trigger='novel'|'bookmark'` で記録)。
- サーバー停止時は実行中の run を `failed` にマークする(起動時に `running` のまま残った行を `failed` に更新)。

## 作品 1 件のバックアップ手順 (`backup/service.ts` `backupNovel(novelId, {force})`)

1. `adapter.fetchNovel(novelKey)`。
   - `SiteNotFoundError` → `novels.is_deleted_on_site = 1`、`last_error` 記録、終了(データは消さない)。
   - その他エラー → `last_error` 記録、run の errors に追加、終了。
2. `novels` の title/author/url/site_status を更新、`is_deleted_on_site = 0`。
3. メタ版:`hash = sha256(JSON(meta without volatile fields) + JSON(toc))`。最新版と異なれば `novel_meta_versions` に追加。
4. 目次同期(トランザクション):
   - 目次にある話 → `episodes` を upsert(position, title, chapter, site_*_at 更新、`removed_at = NULL`)。
   - DB にあって目次に無い話 → `removed_at` を設定(未設定の場合のみ)。
5. 本文取得対象を決定:
   - 版が 1 つも無い話
   - `site_updated_at` が最新版の `site_updated_at` と異なる話
   - `force` または `fullRecheckEveryRuns` に該当する実行なら全話(removed を除く)
   - `maxEpisodesPerNovelPerRun` で上限(position 昇順)
6. 対象話を順に `adapter.fetchEpisode`。正規化(改行・前後空白の統一、HTML 属性順は cheerio 出力で安定させる)して `content_hash` を計算し、**最新版と異なる時だけ** `episode_versions` に version+1 で追加。
   - 個別話の取得失敗は errors に記録して次の話へ(作品全体は継続)。
7. 新版が 1 つでも追加されたら `novels.last_changed_at = now`。`last_checked_at = now`、成功時 `last_error = NULL`。

## 版の閲覧

- 話ごとに版一覧(取得日時、サイト更新日時)を表示し、任意の版を表示可能。
- 2 つの版を選んで差分表示:クライアントで HTML→テキスト化(`<br>`/`</p>` を改行)し `diff` の `diffLines`(長文は `diffChars` ではなく `diffLines` → 変更行内のみ `diffChars`)。
- 削除された話(`removed_at` あり)は目次に「削除済み」バッジ付きで表示し続ける。
- 作品メタの版(あらすじ・タイトル変更)も履歴として表示。

## ログ

`console` に `[backup] novel=narou/n1234ab fetched=3 added=2` 程度の 1 行ログ。

## 実装メモ(Phase 4 で確定した事項)

- ファイル: `backup/hash.ts`(episodeContentHash / metaHash)、`backup/service.ts`(`backupNovel(db, getAdapter, novelId, {force, maxEpisodes})`。例外は投げず結果に errors を積む)、`backup/scheduler.ts`(`BackupScheduler` クラス + 純関数 `computeNextRun` + `markStaleRunsFailed`)、`backup/queue.ts`(`setBackupQueue` で scheduler を登録。未登録ならログのみ)。`createApp({ scheduler })` で注入可能(省略時は未開始のインスタンスを内部生成)。
- **次回実行時刻**: `backupStartAt` あり = サーバーのローカル時刻で「今日の startAt」を基準に interval 分刻みのスロットのうち now より後で最初のもの(停止中に過ぎたスロットは補完しない)。なし = 直近の定期/手動(全体)実行の終了時刻 + interval(履歴が無ければ起動時刻 + interval、過ぎていれば即時)。一括実行中は予約せず、終了時に再計算。設定変更は `onSettingsChanged` 経由で `reschedule()`。タイマーは `unref`、`setTimeout` 上限超過時は到達時に再評価。
- **fullRecheckEveryRuns**: `trigger='schedule'` の通算実行回数(今回を含む。`backup_runs` から数える)が N の倍数のとき全話再取得。手動実行の `force` も同じ経路。カクヨム(改稿日なし)の改稿検知はこれか force のみ。
- **一括実行**は同時に 1 つ(実行中は `runAll` が `started:false`、API は 409 `already_running`)。作品単位キューは一括実行とは独立の逐次ワーカー(同一作品の重複投入は無視)。同一作品の処理は作品 ID 単位のロックで直列化。
- 目次が空で返ったのに既存の話がある場合は「パース異常」として同期せず失敗扱い(全話を removed にしない)。本文が同一で更新日時だけ変わった場合は最新版の `site_updated_at` を更新(毎回の再取得を防ぐ)。話の取得でブロック(`SiteBlockedError`)されたら当該作品の残りを中断。
- `last_checked_at` は作品取得に成功(一部の話の失敗含む)した時のみ更新。作品取得の失敗(404 / ブロック / その他)では更新せず `last_error` のみ。
- run の status: エラー無し=success / 全作品失敗=failed / それ以外でエラーあり=partial。`versions_added` はメタ版 + 話の版の合計。

## 実装メモ: ハーメルン接続設定

- 設定キー `hamelnCookie`(string, 既定 "", 最大 8192, 制御文字不可)/ `hamelnUserAgent`(string, 既定 "", 最大 500)。管理者のみ。
- `GET/PUT /api/settings` の応答は Cookie 値を含まず、`hamelnCookieSet: boolean` と `hamelnCookieNames: string[]`(Cookie 名のみ)を返す。PUT で省略=変更なし、`""`=クリア。Cookie はログに出さない。DB の settings テーブルに JSON として平文保存(秘密情報として API では非公開)。
- 限界: Cloudflare のクリアランスは IP/UA 紐付きかつ期限あり。バックアップ中にブロックされた作品は従来どおり失敗扱い(エラーに設定画面への案内を含む)。
