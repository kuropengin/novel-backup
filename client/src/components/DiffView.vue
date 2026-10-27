<script setup lang="ts">
import { diffChars, diffLines } from "diff";
import { computed, ref } from "vue";

/** 2 版のテキスト差分。追加=緑 / 削除=赤。行単位(diffLines)+ 変更行ペアは文字単位(diffChars)で強調。 */
const props = defineProps<{ oldText: string; newText: string }>();

interface Part {
  text: string;
  hl: boolean;
}
interface Row {
  type: "add" | "del" | "same" | "skip";
  parts: Part[];
}

const CONTEXT = 3;
const full = ref(false);

function splitLines(v: string): string[] {
  const lines = v.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const rows = computed<Row[]>(() => {
  const chunks = diffLines(props.oldText, props.newText);
  const out: Row[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    if (c.removed && chunks[i + 1]?.added) {
      // 削除 + 追加の隣接ペア: 同じ位置の行同士で文字単位の差分を出す
      const del = splitLines(c.value);
      const add = splitLines(chunks[i + 1]!.value);
      const pairs = Math.min(del.length, add.length);
      const delRows: Row[] = [];
      const addRows: Row[] = [];
      for (let k = 0; k < pairs; k++) {
        const parts = diffChars(del[k]!, add[k]!);
        delRows.push({ type: "del", parts: parts.filter((p) => !p.added).map((p) => ({ text: p.value, hl: !!p.removed })) });
        addRows.push({ type: "add", parts: parts.filter((p) => !p.removed).map((p) => ({ text: p.value, hl: !!p.added })) });
      }
      for (let k = pairs; k < del.length; k++) delRows.push({ type: "del", parts: [{ text: del[k]!, hl: false }] });
      for (let k = pairs; k < add.length; k++) addRows.push({ type: "add", parts: [{ text: add[k]!, hl: false }] });
      out.push(...delRows, ...addRows);
      i++;
    } else if (c.removed || c.added) {
      for (const l of splitLines(c.value)) out.push({ type: c.added ? "add" : "del", parts: [{ text: l, hl: false }] });
    } else {
      for (const l of splitLines(c.value)) out.push({ type: "same", parts: [{ text: l, hl: false }] });
    }
  }
  return out;
});

const changed = computed(() => rows.value.some((r) => r.type !== "same"));
const stats = computed(() => ({
  add: rows.value.filter((r) => r.type === "add").length,
  del: rows.value.filter((r) => r.type === "del").length,
}));

/** 変更の前後 CONTEXT 行以外の変更なし行を折りたたむ */
const shown = computed<Row[]>(() => {
  if (full.value) return rows.value;
  const r = rows.value;
  const keep = new Array<boolean>(r.length).fill(false);
  r.forEach((row, i) => {
    if (row.type === "same") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(r.length - 1, i + CONTEXT); k++) keep[k] = true;
  });
  const out: Row[] = [];
  let skipped = 0;
  r.forEach((row, i) => {
    if (keep[i]) {
      if (skipped) out.push({ type: "skip", parts: [{ text: `… 変更のない ${skipped} 行 …`, hl: false }] });
      skipped = 0;
      out.push(row);
    } else skipped++;
  });
  if (skipped) out.push({ type: "skip", parts: [{ text: `… 変更のない ${skipped} 行 …`, hl: false }] });
  return out;
});
</script>

<template>
  <div class="diff">
    <div class="bar">
      <span class="muted">
        <span class="plus">+{{ stats.add }}</span> / <span class="minus">-{{ stats.del }}</span> 行
      </span>
      <label class="check"><input v-model="full" type="checkbox" /> 全文表示</label>
    </div>
    <p v-if="!changed" class="muted pad">差分はありません(本文は同一です)。</p>
    <div v-else class="lines">
      <div v-for="(r, i) in shown" :key="i" class="line" :class="r.type">
        <span class="mark">{{ r.type === "add" ? "+" : r.type === "del" ? "-" : " " }}</span>
        <span class="txt"><template v-for="(p, j) in r.parts" :key="j"><mark v-if="p.hl">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff { border: 1px solid var(--c-border); border-radius: 8px; background: var(--c-surface); }
.bar { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--c-border); font-size: 13px; }
.check { display: flex; gap: 4px; align-items: center; }
.pad { padding: 10px; }
.plus { color: #1a7f37; }
.minus { color: var(--c-danger); }
.lines { font-size: 14px; line-height: 1.7; overflow-x: auto; }
.line { display: flex; gap: 6px; padding: 0 10px; }
.mark { width: 1em; flex-shrink: 0; color: var(--c-muted); user-select: none; }
.txt { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; flex: 1; }
.line.add { background: rgba(46, 160, 67, 0.16); }
.line.del { background: rgba(248, 81, 73, 0.16); }
.line.skip { color: var(--c-muted); background: var(--c-bg); font-size: 12px; }
.line.add mark { background: rgba(46, 160, 67, 0.5); color: inherit; }
.line.del mark { background: rgba(248, 81, 73, 0.5); color: inherit; text-decoration: line-through; }
</style>
