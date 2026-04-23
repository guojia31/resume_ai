/*
  Neo‑Brutalist Paperwork UI — Home
  Principle: Split the "document" (JD) and the "evidence" (resumes).
*/

import { useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { Download, FileText, Loader2, Plus, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { parsePdfToText } from "@/lib/pdf";
import { normalizeText, sha256Base64 } from "@/lib/text";
import { parseJD, scoreResume } from "@/lib/scoring";
import type { ResumeItem } from "@/lib/types";

type AppState = {
  jdText: string;
  resumes: ResumeItem[];
  weights?: { hard: number; exp: number; edu: number; soft: number };
};

const STORAGE_KEY = "ai-hiring-assistant:v1";

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { jdText: "", resumes: [] };
    const parsed = JSON.parse(raw) as AppState;
    return {
      jdText: typeof parsed.jdText === "string" ? parsed.jdText : "",
      resumes: Array.isArray(parsed.resumes) ? parsed.resumes : [],
      weights:
        parsed.weights &&
        typeof parsed.weights.hard === "number" &&
        typeof parsed.weights.exp === "number" &&
        typeof parsed.weights.edu === "number" &&
        typeof parsed.weights.soft === "number"
          ? parsed.weights
          : undefined,
    };
  } catch {
    return { jdText: "", resumes: [] };
  }
}

function saveState(next: AppState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

function ScoreLine({
  label,
  value,
  max,
  strong,
}: {
  label: string;
  value: number;
  max: number;
  strong?: boolean;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={"grid grid-cols-[88px_1fr_52px] items-center gap-2 " + (strong ? "font-semibold" : "")}
    >
      <div className="text-xs text-muted-foreground font-mono">{label}</div>
      <div className="h-2 brutal-border bg-background/60">
        <div className="h-full bg-primary" style={{ width: pct + "%" }} />
      </div>
      <div className="text-right font-mono text-xs">
        {Math.round(value)}/{max}
      </div>
    </div>
  );
}

function WeightRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="grid grid-cols-[70px_1fr_42px] items-center gap-2">
      <div className="text-xs text-muted-foreground font-mono">{label}</div>
      <Slider
        value={[value]}
        min={0}
        max={100}
        step={1}
        onValueChange={(v) => onChange(v[0] ?? 0)}
      />
      <div className="text-right font-mono text-xs">{value}</div>
    </div>
  );
}

function downloadText(filename: string, content: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function Home({
  // kept for tolerant routing template; not used in this app
  targetSection,
}: {
  targetSection?: string;
}) {
  void targetSection;

  const [activeTab, setActiveTab] = useState<"setup" | "results">("setup");
  const loaded = useMemo(() => loadState(), []);
  const [jdText, setJdText] = useState<string>(() => loaded.jdText);
  const [resumes, setResumes] = useState<ResumeItem[]>(() => loaded.resumes);
  const [weights, setWeights] = useState(() => loaded.weights ?? { hard: 40, exp: 30, edu: 20, soft: 10 });

  const [candidateName, setCandidateName] = useState("");
  const [resumeText, setResumeText] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [isParsing, setIsParsing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    saveState({ jdText, resumes, weights });
  }, [jdText, resumes, weights]);

  const stats = useMemo(() => {
    const total = resumes.length;
    const uniqueHashes = new Set(resumes.map((r) => r.hash));
    const duplicates = total - uniqueHashes.size;
    return { total, duplicates };
  }, [resumes]);

  const jdReq = useMemo(() => parseJD(jdText), [jdText]);

  const normWeights = useMemo(() => {
    const sum = weights.hard + weights.exp + weights.edu + weights.soft;
    if (!sum) return { hardSkills: 0.4, experience: 0.3, education: 0.2, softSkills: 0.1 };
    return {
      hardSkills: weights.hard / sum,
      experience: weights.exp / sum,
      education: weights.edu / sum,
      softSkills: weights.soft / sum,
    };
  }, [weights]);

  const scored = useMemo(() => {
    if (!jdText.trim() || resumes.length === 0) {
      return [] as Array<{ r: ResumeItem; s: ReturnType<typeof scoreResume> }>;
    }
    return resumes
      .map((r) => ({ r, s: scoreResume(jdReq, r, normWeights) }))
      .sort((a, b) => b.s.total - a.s.total);
  }, [jdReq, jdText, normWeights, resumes]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return scored.find((x) => x.r.id === selectedId) ?? null;
  }, [scored, selectedId]);

  async function addResumeFromText(args: { candidateName: string; text: string; fileName?: string }) {
    const raw = args.text.trim();
    if (!raw) {
      toast.error("简历内容为空");
      return;
    }
    const normalized = normalizeText(raw);
    const hash = await sha256Base64(normalized);

    setResumes((prev) => {
      const isDup = prev.some((x) => x.hash === hash);
      const next: ResumeItem = {
        id: nanoid(),
        candidateName: args.candidateName.trim() || "未命名候选人",
        fileName: args.fileName,
        rawText: raw,
        normalizedText: normalized,
        hash,
        createdAtUtc: new Date().toISOString(),
      };
      const merged = isDup
        ? [
            next,
            ...prev.filter((x) => x.hash !== hash),
            ...prev.filter((x) => x.hash === hash),
          ]
        : [next, ...prev];
      toast.success(isDup ? "检测到重复简历，已合并为最新版本" : "已添加简历");
      return merged;
    });

    setCandidateName("");
    setResumeText("");
  }

  async function handlePdfFiles(files: FileList) {
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;
    if (fileArr.length > 50) {
      toast.error("单次最多处理 50 份简历，请分批上传");
      return;
    }

    setIsParsing(true);
    const t = toast.loading(`正在解析 ${fileArr.length} 份PDF...`);

    try {
      for (let i = 0; i < fileArr.length; i++) {
        const f = fileArr[i];
        try {
          const txt = await parsePdfToText(f);
          await addResumeFromText({
            candidateName: f.name.replace(/\.pdf$/i, ""),
            text: txt,
            fileName: f.name,
          });
        } catch (e) {
          console.error(e);
          toast.error(`PDF解析失败：${f.name}（可能是扫描版/损坏文件）`);
        }
      }
      toast.success("PDF解析完成", { id: t });
    } catch (e) {
      console.error(e);
      toast.error("解析过程中发生错误", { id: t });
    } finally {
      setIsParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeResume(id: string) {
    setResumes((prev) => prev.filter((r) => r.id !== id));
  }

  function clearAll() {
    setJdText("");
    setResumes([]);
    toast.success("已清空");
  }

  return (
    <div className="min-h-screen paper-noise">
      <header className="mx-auto max-w-6xl px-4 pt-8 pb-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 brutal-border bg-primary text-primary-foreground grid place-items-center">
                <FileText className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight">AI 简历筛选助手</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  输入JD + 批量PDF简历 → 生成候选人匹配排名（本地解析，数据保存在浏览器）
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="rounded-none font-mono">
              简历 {stats.total}
            </Badge>
            {stats.duplicates > 0 ? (
              <Badge className="rounded-none font-mono" variant="outline">
                重复 {stats.duplicates}
              </Badge>
            ) : null}
            <Button variant="outline" className="rounded-none" onClick={clearAll}>
              清空
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-16">
        <Card className="rounded-none brutal-border bg-card/90">
          <div className="p-4 md:p-6">
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
              <TabsList className="rounded-none bg-transparent p-0 gap-2">
                <TabsTrigger
                  value="setup"
                  className="rounded-none border border-border data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  Setup
                </TabsTrigger>
                <TabsTrigger
                  value="results"
                  className="rounded-none border border-border data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
                >
                  Results
                </TabsTrigger>
              </TabsList>

              <Separator className="my-4" />

              <TabsContent value="setup" className="m-0">
                <div className="grid gap-4 md:grid-cols-2">
                  {/* JD */}
                  <section className="min-w-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <h2 className="font-semibold text-lg">Job Description（JD）</h2>
                      <span className="text-xs text-muted-foreground font-mono">支持中英文</span>
                    </div>
                    <Textarea
                      value={jdText}
                      onChange={(e) => setJdText(e.target.value)}
                      placeholder="粘贴完整JD文本…\n\n建议包含：硬技能、经验年限、教育背景、软技能、证书等。"
                      className="mt-3 min-h-[260px] rounded-none brutal-border bg-background/70"
                    />

                    <div className="mt-3 text-xs text-muted-foreground leading-relaxed">
                      提示：如果JD信息太少，后续评分会偏保守。你可以先用一个粗略JD跑一遍，再逐步补充。
                    </div>
                  </section>

                  {/* Resumes */}
                  <section className="min-w-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <h2 className="font-semibold text-lg">Resumes（简历）</h2>
                      <div className="flex items-center gap-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="application/pdf"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            const files = e.target.files;
                            if (files) void handlePdfFiles(files);
                          }}
                        />
                        <Button
                          variant="outline"
                          className="rounded-none"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={isParsing}
                        >
                          {isParsing ? (
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          ) : (
                            <Upload className="h-4 w-4 mr-2" />
                          )}
                          批量上传PDF
                        </Button>
                      </div>
                    </div>

                    <div className="mt-3 grid gap-2">
                      <Input
                        value={candidateName}
                        onChange={(e) => setCandidateName(e.target.value)}
                        placeholder="候选人姓名（可选）"
                        className="rounded-none brutal-border bg-background/70"
                      />
                      <div className="flex gap-2">
                        <Textarea
                          value={resumeText}
                          onChange={(e) => setResumeText(e.target.value)}
                          placeholder="粘贴简历文本（适合复制自Word/招聘平台）…"
                          className="min-h-[160px] rounded-none brutal-border bg-background/70 flex-1"
                        />
                        <Button
                          className="rounded-none h-[160px] w-28 shrink-0"
                          onClick={() => void addResumeFromText({ candidateName, text: resumeText })}
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          添加
                        </Button>
                      </div>

                      <div className="text-xs text-muted-foreground leading-relaxed">
                        说明：扫描版PDF（纯图片）可能无法解析；建议导出为可复制文本，或直接粘贴简历内容。
                      </div>
                    </div>

                    <Separator className="my-4" />

                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold">已添加简历</h3>
                      <Button
                        variant="outline"
                        className="rounded-none"
                        onClick={() => setActiveTab("results")}
                        disabled={!jdText.trim() || resumes.length === 0}
                      >
                        进入结果页
                      </Button>
                    </div>

                    <div className="mt-3">
                      {resumes.length === 0 ? (
                        <div className="rounded-none border border-dashed border-border p-4 text-sm text-muted-foreground">
                          暂无简历。你可以上传PDF或粘贴文本。
                        </div>
                      ) : (
                        <ScrollArea className="h-[210px] rounded-none border border-border">
                          <div className="divide-y divide-border">
                            {resumes.map((r) => (
                              <div key={r.id} className="flex items-start justify-between gap-3 p-3">
                                <div className="min-w-0">
                                  <div className="font-medium truncate">{r.candidateName}</div>
                                  <div className="text-xs text-muted-foreground font-mono truncate">
                                    {r.fileName ? r.fileName : "手动粘贴"} · {r.hash.slice(0, 10)}…
                                  </div>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="rounded-none"
                                  onClick={() => removeResume(r.id)}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      )}
                    </div>
                  </section>
                </div>
              </TabsContent>

              <TabsContent value="results" className="m-0">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="md:col-span-2 min-w-0">
                    <div className="flex items-baseline justify-between gap-3">
                      <div>
                        <h2 className="font-semibold text-lg">候选人匹配排行</h2>
                        <p className="text-xs text-muted-foreground mt-1">
                          评分：硬技能40% · 经历30% · 教育20% · 软技能10%（+ 最多10分加分项）
                        </p>
                      </div>
                      <Button variant="outline" className="rounded-none" onClick={() => setActiveTab("setup")}
                        >返回编辑</Button>
                    </div>

                    {!jdText.trim() || resumes.length === 0 ? (
                      <div className="mt-3 rounded-none border border-dashed border-border p-4 text-sm text-muted-foreground">
                        请先在 Setup 页输入JD并添加至少 1 份简历。
                      </div>
                    ) : (
                      <div className="mt-3 rounded-none border border-border overflow-hidden">
                        <ScrollArea className="h-[420px]">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-[70px] font-mono">Rank</TableHead>
                                <TableHead>候选人</TableHead>
                                <TableHead className="w-[110px] text-right font-mono">Score</TableHead>
                                <TableHead className="hidden md:table-cell">核心契合</TableHead>
                                <TableHead className="hidden md:table-cell">关键差距</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {scored.map((x, idx) => (
                                <TableRow
                                  key={x.r.id}
                                  className={
                                    "cursor-pointer hover:bg-secondary/60 " +
                                    (selectedId === x.r.id ? "bg-secondary/60" : "")
                                  }
                                  onClick={() => setSelectedId(x.r.id)}
                                >
                                  <TableCell className="font-mono">{idx + 1}</TableCell>
                                  <TableCell className="min-w-0">
                                    <div className="font-medium truncate">{x.r.candidateName}</div>
                                    <div className="text-xs text-muted-foreground font-mono truncate">
                                      {x.r.fileName ? x.r.fileName : "手动粘贴"}
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-right font-mono">
                                    <span className={x.s.total >= 80 ? "text-foreground" : "text-muted-foreground"}>
                                      {x.s.total}
                                    </span>
                                  </TableCell>
                                  <TableCell className="hidden md:table-cell text-sm">
                                    {x.s.coreFit.slice(0, 2).join("；") || "—"}
                                  </TableCell>
                                  <TableCell className="hidden md:table-cell text-sm">
                                    {x.s.keyGaps.slice(0, 1).join("；") || "—"}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </ScrollArea>
                      </div>
                    )}
                  </div>

                  <div className="min-w-0">
                    <h3 className="font-semibold">详细解释（透明可追溯）</h3>

                    <div className="mt-3 rounded-none border border-border p-3 text-sm">
                      <div className="text-xs text-muted-foreground font-mono">JD解析</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(jdReq.hardSkills.slice(0, 10).length ? jdReq.hardSkills.slice(0, 10) : ["（未识别到技能关键词）"]).map(
                          (k) => (
                            <Badge key={k} variant="secondary" className="rounded-none font-mono">
                              {k}
                            </Badge>
                          )
                        )}
                      </div>
                      {jdReq.minYears ? (
                        <div className="mt-2 text-xs text-muted-foreground">
                          经验要求（粗略识别）：{jdReq.minYears} 年+
                        </div>
                      ) : null}
                      {jdReq.minDegreeLevel ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          学历要求（粗略识别）：≥ {jdReq.minDegreeLevel}
                        </div>
                      ) : null}
                    </div>

                    <div className="mt-3 rounded-none border border-border p-3 text-sm">
                      <div className="flex items-baseline justify-between">
                        <div className="text-xs text-muted-foreground font-mono">权重配置</div>
                        <div className="text-xs text-muted-foreground font-mono">合计 {weights.hard + weights.exp + weights.edu + weights.soft}</div>
                      </div>

                      <div className="mt-3 grid gap-3">
                        <WeightRow
                          label="硬技能"
                          value={weights.hard}
                          onChange={(v) => setWeights((p) => ({ ...p, hard: v }))}
                        />
                        <WeightRow
                          label="经历"
                          value={weights.exp}
                          onChange={(v) => setWeights((p) => ({ ...p, exp: v }))}
                        />
                        <WeightRow
                          label="教育"
                          value={weights.edu}
                          onChange={(v) => setWeights((p) => ({ ...p, edu: v }))}
                        />
                        <WeightRow
                          label="软技能"
                          value={weights.soft}
                          onChange={(v) => setWeights((p) => ({ ...p, soft: v }))}
                        />
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          className="rounded-none"
                          onClick={() => setWeights({ hard: 40, exp: 30, edu: 20, soft: 10 })}
                        >
                          重置默认
                        </Button>
                        <Button
                          variant="outline"
                          className="rounded-none"
                          onClick={() => {
                            const rows = scored.map((x, idx) => ({
                              rank: idx + 1,
                              candidate: x.r.candidateName,
                              score: x.s.total,
                              core_fit: x.s.coreFit.join("; "),
                              key_gaps: x.s.keyGaps.join("; "),
                              file: x.r.fileName ?? "粘贴",
                            }));
                            const header = Object.keys(rows[0] ?? { rank: "", candidate: "", score: "", core_fit: "", key_gaps: "", file: "" });
                            const csv = [header.join(",")]
                              .concat(
                                rows.map((r) =>
                                  header
                                    .map((k) => {
                                      const v = String((r as any)[k] ?? "").replace(/"/g, '""');
                                      return `"${v}"`;
                                    })
                                    .join(",")
                                )
                              )
                              .join("\n");
                            downloadText("候选人匹配排行.csv", csv, "text/csv;charset=utf-8");
                            toast.success("已导出 CSV");
                          }}
                          disabled={!jdText.trim() || resumes.length === 0}
                        >
                          <Download className="h-4 w-4 mr-2" />
                          导出CSV
                        </Button>
                      </div>
                    </div>

                    <div className="mt-3 rounded-none border border-border p-3">
                      {!selected ? (
                        <div className="text-sm text-muted-foreground">点击左侧候选人查看评分拆解。</div>
                      ) : (
                        <div className="space-y-3">
                          <div>
                            <div className="text-xs text-muted-foreground font-mono">候选人</div>
                            <div className="font-semibold truncate">{selected.r.candidateName}</div>
                            <div className="text-xs text-muted-foreground font-mono truncate">
                              {selected.r.fileName ? selected.r.fileName : "手动粘贴"}
                            </div>
                          </div>

                          <Separator />

                          <div className="grid gap-2 text-sm">
                            <ScoreLine label="总分" value={selected.s.total} max={100} strong />
                            <ScoreLine
                              label="硬技能"
                              value={selected.s.hardSkills.score}
                              max={selected.s.hardSkills.max}
                            />
                            <ScoreLine
                              label="经历"
                              value={selected.s.experience.score}
                              max={selected.s.experience.max}
                            />
                            <ScoreLine
                              label="教育"
                              value={selected.s.education.score}
                              max={selected.s.education.max}
                            />
                            <ScoreLine
                              label="软技能"
                              value={selected.s.softSkills.score}
                              max={selected.s.softSkills.max}
                            />
                            <ScoreLine label="加分项" value={selected.s.bonus.score} max={selected.s.bonus.max} />
                          </div>

                          {selected.s.keyGaps.length ? (
                            <div>
                              <div className="text-xs text-muted-foreground font-mono">关键差距</div>
                              <ul className="mt-1 list-disc pl-5 text-sm">
                                {selected.s.keyGaps.map((g) => (
                                  <li key={g}>{g}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}

                          <div>
                            <div className="text-xs text-muted-foreground font-mono">命中技能（部分）</div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {(selected.s.hardSkills.matched.slice(0, 10).length
                                ? selected.s.hardSkills.matched.slice(0, 10)
                                : ["—"]
                              ).map((k) => (
                                <Badge key={k} className="rounded-none" variant="outline">
                                  {k}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="mt-4 text-xs text-muted-foreground leading-relaxed">
                      隐私：本工具默认本地运行。评分为启发式规则（可解释、可调整）。
                    </div>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </Card>

        <footer className="mt-6 text-xs text-muted-foreground leading-relaxed">
          <div className="flex flex-col gap-1">
            <div>隐私：本工具默认本地解析PDF，不会自动上传简历或JD。</div>
            <div>限制：扫描版PDF可能无法提取文字；请使用可复制文本的PDF或直接粘贴内容。</div>
          </div>
        </footer>
      </main>
    </div>
  );
}
