/*
  Heuristic, transparent scoring (no black box)
  - Works for CN/EN by keyword + simple rules
  - Designed to be local-first; you can later swap in LLM scoring.
*/

import { normalizeText } from "@/lib/text";
import type { ResumeItem } from "@/lib/types";

export type ScoringWeights = {
  hardSkills: number; // 0-1
  experience: number;
  education: number;
  softSkills: number;
};

export type JDRequirements = {
  raw: string;
  normalized: string;
  hardSkills: string[];
  softSkills: string[];
  bonusKeywords: string[];
  minYears?: number;
  minDegreeLevel?: DegreeLevel;
};

export type DegreeLevel = "unknown" | "associate" | "bachelor" | "master" | "phd";

export type ResumeScoreBreakdown = {
  total: number;
  hardSkills: { score: number; max: number; matched: string[]; missing: string[] };
  experience: { score: number; max: number; resumeYears?: number; requiredYears?: number };
  education: { score: number; max: number; resumeDegree: DegreeLevel; requiredDegree?: DegreeLevel };
  softSkills: { score: number; max: number; matched: string[]; missing: string[] };
  bonus: { score: number; max: number; matched: string[] };
  keyGaps: string[];
  coreFit: string[];
};

const DEFAULT_WEIGHTS: ScoringWeights = {
  hardSkills: 0.4,
  experience: 0.3,
  education: 0.2,
  softSkills: 0.1,
};

const COMMON_HARD_SKILLS = [
  // EN
  "python",
  "java",
  "javascript",
  "typescript",
  "react",
  "node",
  "sql",
  "mysql",
  "postgres",
  "mongodb",
  "redis",
  "docker",
  "kubernetes",
  "aws",
  "gcp",
  "azure",
  "linux",
  "git",
  "spark",
  "hadoop",
  "llm",
  "nlp",
  "machine learning",
  "deep learning",
  "data analysis",
  // CN
  "数据分析",
  "机器学习",
  "深度学习",
  "自然语言处理",
  "大模型",
  "后端",
  "前端",
  "全栈",
  "产品经理",
  "项目管理",
  "需求分析",
  "数据仓库",
  "算法",
  "测试",
  "运维",
];

const COMMON_SOFT_SKILLS = [
  "沟通",
  "协作",
  "团队",
  "领导",
  "抗压",
  "自驱",
  "表达",
  "问题解决",
  "学习能力",
  "ownership",
  "communication",
  "teamwork",
  "leadership",
  "problem solving",
  "stakeholder",
];

const COMMON_BONUS = ["pmp", "aws", "cfa", "cpa", "scrum", "itil", "认证", "certification"];

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function contains(haystack: string, needle: string) {
  // needle already normalized-ish; keep simple
  return haystack.includes(needle);
}

function extractYears(text: string): number | undefined {
  // EN: 3+ years, 3 years; CN: 3年
  const t = text;
  const m1 = t.match(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/);
  if (m1) return Number(m1[1]);
  const m2 = t.match(/(\d{1,2})\s*年/);
  if (m2) return Number(m2[1]);
  return undefined;
}

function degreeLevelFromText(text: string): DegreeLevel {
  const t = text;
  if (/(phd|doctor|博士)/.test(t)) return "phd";
  if (/(master|msc|硕士|研究生)/.test(t)) return "master";
  if (/(bachelor|bsc|本科)/.test(t)) return "bachelor";
  if (/(associate|大专)/.test(t)) return "associate";
  return "unknown";
}

function degreeMeets(resume: DegreeLevel, req?: DegreeLevel) {
  if (!req || req === "unknown") return true;
  const order: DegreeLevel[] = ["unknown", "associate", "bachelor", "master", "phd"];
  return order.indexOf(resume) >= order.indexOf(req);
}

export function parseJD(jdText: string): JDRequirements {
  const raw = jdText || "";
  const normalized = normalizeText(raw);

  const hardFound: string[] = [];
  const softFound: string[] = [];
  const bonusFound: string[] = [];

  for (const k of COMMON_HARD_SKILLS) {
    const nk = normalizeText(k);
    if (contains(normalized, nk)) hardFound.push(k);
  }
  for (const k of COMMON_SOFT_SKILLS) {
    const nk = normalizeText(k);
    if (contains(normalized, nk)) softFound.push(k);
  }
  for (const k of COMMON_BONUS) {
    const nk = normalizeText(k);
    if (contains(normalized, nk)) bonusFound.push(k);
  }

  // additionally: tech-ish EN tokens (e.g., "Go", "Rust")
  const extraTokens = raw
    .split(/[^A-Za-z0-9+#.\-]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && x.length <= 20);

  const likelySkills = extraTokens.filter((x) => /[A-Za-z]/.test(x)).map((x) => x.toLowerCase());
  const hardSkills = uniq([...hardFound.map((x) => x.toLowerCase()), ...likelySkills]).slice(0, 40);

  const minYears = extractYears(normalized);
  const minDegreeLevel = degreeLevelFromText(normalized);

  return {
    raw,
    normalized,
    hardSkills,
    softSkills: uniq(softFound.map((x) => normalizeText(x))).slice(0, 25),
    bonusKeywords: uniq(bonusFound.map((x) => normalizeText(x))).slice(0, 20),
    minYears,
    minDegreeLevel: minDegreeLevel === "unknown" ? undefined : minDegreeLevel,
  };
}

export function scoreResume(
  req: JDRequirements,
  resume: ResumeItem,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): ResumeScoreBreakdown {
  const maxHard = Math.round(weights.hardSkills * 100);
  const maxExp = Math.round(weights.experience * 100);
  const maxEdu = Math.round(weights.education * 100);
  const maxSoft = Math.round(weights.softSkills * 100);
  const maxBonus = 10;

  const rText = resume.normalizedText;

  const reqHard = req.hardSkills.map((x) => normalizeText(x));
  const matchedHard = reqHard.filter((k) => k && contains(rText, k));
  const missingHard = reqHard.filter((k) => k && !contains(rText, k));

  const hardRatio = reqHard.length ? matchedHard.length / reqHard.length : 0;
  let hardScore = maxHard * hardRatio;

  // Mandatory penalty heuristic: first 8 skills treated as “core”, missing costs 8 points each.
  const coreMissing = missingHard.slice(0, 8);
  hardScore -= coreMissing.length * 8;
  hardScore = Math.max(0, Math.min(maxHard, hardScore));

  const resumeYears = extractYears(rText);
  const requiredYears = req.minYears;
  let expScore = maxExp;
  if (requiredYears && requiredYears > 0) {
    if (!resumeYears) expScore = maxExp * 0.55;
    else expScore = Math.min(maxExp, (resumeYears / requiredYears) * maxExp);
  } else {
    expScore = maxExp * 0.75;
  }

  const resumeDegree = degreeLevelFromText(rText);
  const eduOk = degreeMeets(resumeDegree, req.minDegreeLevel);
  let eduScore = eduOk ? maxEdu : maxEdu * 0.4;
  if (resumeDegree === "unknown") eduScore = maxEdu * 0.6;

  const reqSoft = req.softSkills;
  const matchedSoft = reqSoft.filter((k) => k && contains(rText, k));
  const missingSoft = reqSoft.filter((k) => k && !contains(rText, k));
  const softRatio = reqSoft.length ? matchedSoft.length / reqSoft.length : 0;
  const softScore = Math.min(maxSoft, maxSoft * (reqSoft.length ? softRatio : 0.7));

  const bonusMatched = req.bonusKeywords.filter((k) => k && contains(rText, k));
  const bonusScore = Math.min(maxBonus, bonusMatched.length * 3);

  const total = clamp(Math.round(hardScore + expScore + eduScore + softScore + bonusScore), 0, 100);

  const coreFit: string[] = [];
  if (matchedHard.length) coreFit.push(`硬技能命中 ${matchedHard.length}/${reqHard.length}`);
  if (requiredYears) coreFit.push(`经验年限：${resumeYears ?? "未识别"} / 需求 ${requiredYears}`);
  if (req.minDegreeLevel) coreFit.push(`学历：${resumeDegree}（需求 ≥ ${req.minDegreeLevel}）`);

  const keyGaps: string[] = [];
  if (coreMissing.length) keyGaps.push(`核心技能缺失：${coreMissing.slice(0, 4).join("、")}${coreMissing.length > 4 ? "…" : ""}`);
  if (requiredYears && resumeYears && resumeYears < requiredYears) keyGaps.push(`经验年限不足：${resumeYears} < ${requiredYears}`);
  if (req.minDegreeLevel && !eduOk) keyGaps.push(`学历不满足：${resumeDegree} < ${req.minDegreeLevel}`);

  return {
    total,
    hardSkills: { score: round1(hardScore), max: maxHard, matched: matchedHard, missing: missingHard },
    experience: { score: round1(expScore), max: maxExp, resumeYears, requiredYears },
    education: { score: round1(eduScore), max: maxEdu, resumeDegree, requiredDegree: req.minDegreeLevel },
    softSkills: { score: round1(softScore), max: maxSoft, matched: matchedSoft, missing: missingSoft },
    bonus: { score: round1(bonusScore), max: maxBonus, matched: bonusMatched },
    keyGaps,
    coreFit,
  };
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
