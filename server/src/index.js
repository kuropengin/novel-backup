import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";

//  Serverひな型: Express + API + ビルド済みクライアントの同一origin配信(PWA)
const app = express();
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ ok: true, name: "novel-backup", version: "0.1.0" });
});

// 本番: client/dist を同一originで配信(サービスワーカー/マニフェストがルートに届く)
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
if (fs.existsSync(path.join(dist, "index.html"))) {
  app.use(express.static(dist));
}

// SPAのcatch-all
app.use((req, res) => {
  const index = path.join(dist, "index.html");
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send("client not built. run: npm run build");
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`novel-backup server: http://localhost:${PORT}`));
