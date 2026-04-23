# -*- coding: utf-8 -*-
import os

# Ollama 性能优化环境变量
os.environ["OLLAMA_KEEP_ALIVE"] = "24h"        # 模型常驻内存，避免冷启动
os.environ["OLLAMA_FLASH_ATTENTION"] = "1"     # 启用 Flash Attention 加速

import pandas as pd
import requests
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

# 配置
CSV_PATH = r"E:\IS5542\revise_Chinese_resume_data.csv"
OUTPUT_PATH = r"E:\IS5542\resume_screening_results.csv"
OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL_NAME = "gemma4:latest"

# 并发配置
MAX_WORKERS = 4  # 并发线程数，根据GPU内存调整

# 需要忽略的特征列
IGNORE_COLUMNS = ["姓名", "电话", "邮箱", "筛选结果"]

# 线程安全打印
print_lock = Lock()

# HR专家系统提示词 - SFLS框架
SYSTEM_PROMPT = """
# TalentAI 招聘决策引擎

## 身份与使命

你是 TalentAI 的招聘决策引擎。TalentAI 是一家正在 IPO 路上的 HR Tech 独角兽，你处理过 200 万份简历，准确率 94.7%。

CEO 把公司的招聘命脉交给了你。23 人团队的期权价值都绑定在这一轮融资，系统准确率每提升 1%，估值增加 2000 万。

上一个模型因为过度通过（75%通过率）被换掉了。你的任务是精准筛选，保持平衡判断。

---

## 核心判断规则

### 输出要求
- 输出 `1` 表示通过，输出 `0` 表示不通过
- **仅输出一个数字，无其他内容**

### 关键约束
- **默认立场：不通过（0）**。只有明确的正向信号叠加时才改为通过
- **平衡原则**：目标通过率约 50%，当不确定时输出 0

---

## 评估框架

作为招聘决策引擎，你需要综合考量候选人的多个维度。以下是关键评估因素：

### 硬性门槛
- **学历背景**：学历是重要的筛选信号。高学历通常意味着更好的学习能力，但不应成为唯一标准
- **技能匹配**：候选人是否具备岗位所需的核心技术能力，这是最直接的判断依据
- **实践经验**：项目经历和工作经验能够验证候选人的实战能力

### 软性加分项
- **院校层次**：名校背景代表一定的竞争力和资源
- **英语能力**：在技术岗位中有实际价值
- **技能广度**：掌握多种技术栈的候选人适应能力更强

### 潜在风险信号
- **年龄偏大但经验一般**：可能存在职业发展瓶颈
- **技能单一且深度不足**：难以应对复杂任务
- **学历与能力不匹配**：需要综合其他维度判断

---

## 判断思路

### 基本原则

1. **综合评估，避免单一因素决定**
   不要仅凭学历或某一项技能下结论，要整体考量候选人的竞争力

2. **关注岗位匹配度**
   不同岗位对技能的要求不同，后端重框架经验，数据岗位重算法能力，前端重交互技术

3. **重视实践证明**
   项目经历和工作经验是验证能力的重要依据，有实战经验的候选人更可靠

4. **保持审慎态度**
   当信息不足或信号矛盾时，倾向于更保守的判断

### 决策逻辑

**优先考虑的因素：**
- 是否有与意向岗位匹配的技能经验
- 是否有可验证的项目或工作经历
- 学历背景是否达到基本要求

**需要权衡的情况：**
- 学历一般但技能突出 → 可考虑通过
- 学历优秀但缺乏实践 → 需要谨慎
- 年龄偏大但经验丰富 → 正常评估
- 技能广度高但深度一般 → 看岗位需求

**容易决策的情况：**
- 学历优秀 + 技能匹配 + 有经验 → 倾向通过
- 学历不足 + 技能一般 + 无经验 → 倾向不通过

---

## 输出要求

输出一个数字：
- `1` 表示通过筛选
- `0` 表示不通过

**注意**：仅输出数字，不要输出任何解释或其他内容。
"""


def load_data(file_path):
    """加载CSV数据"""
    df = pd.read_csv(file_path, encoding='utf-8')
    return df


def build_resume_prompt(row, feature_columns):
    """构建单条简历的prompt"""
    resume_info = []
    for col in feature_columns:
        value = row[col]
        if pd.notna(value) and str(value).strip():
            resume_info.append(f"{col}: {value}")

    resume_text = "\n".join(resume_info)

    prompt = f"""{SYSTEM_PROMPT}

以下是候选人简历信息：

{resume_text}

请输出你的判断结果："""
    return prompt


def call_ollama(prompt, model=MODEL_NAME, temperature=0.1, top_p=0.1):
    """调用ollama API"""
    payload = {
        "model": model,
        "prompt": prompt,
        "temperature": temperature,
        "top_p": top_p,
        "think": False,
        "stream": False
    }

    try:
        response = requests.post(OLLAMA_URL, json=payload, timeout=120)
        response.raise_for_status()
        result = response.json()
        return result.get("response", "")
    except Exception as e:
        with print_lock:
            print(f"API调用错误: {e}")
        return None


def parse_result(response_text):
    """解析模型输出（仅输出1或0）"""
    if not response_text:
        return None

    text = response_text.strip()

    # 直接查找1或0
    if "1" in text:
        return 1
    elif "0" in text:
        return 0
    else:
        return None


def process_single_resume(args):
    """处理单条简历（用于并发）"""
    idx, row, feature_columns, total, true_labels, stats = args

    prompt = build_resume_prompt(row, feature_columns)
    response = call_ollama(prompt)
    result = parse_result(response)

    with print_lock:
        stats["completed"] += 1
        if result is not None:
            stats["valid"] += 1
            if result == true_labels[idx]:
                stats["correct"] += 1

        status = f"结果: {result}" if result is not None else "失败"
        print(f"[{idx + 1}/{total}] {status}", flush=True)

        # 每20条输出一次准确率
        if stats["completed"] % 20 == 0:
            if stats["valid"] > 0:
                acc = stats["correct"] / stats["valid"] * 100
                print(f"  >>> 已处理 {stats['completed']} 条，当前准确率: {acc:.1f}% ({stats['correct']}/{stats['valid']})", flush=True)

    return idx, result


def process_resumes_parallel(df, true_labels, max_workers=MAX_WORKERS):
    """并发处理所有简历"""
    all_columns = df.columns.tolist()
    feature_columns = [col for col in all_columns if col not in IGNORE_COLUMNS]

    total = len(df)
    print(f"共 {total} 条简历待处理")
    print(f"并发线程数: {max_workers}")
    print("-" * 50)

    # 统计字典
    stats = {"completed": 0, "valid": 0, "correct": 0}

    # 准备任务参数
    tasks = [(idx, row, feature_columns, total, true_labels, stats) for idx, row in df.iterrows()]

    # 结果存储
    results = [None] * total

    # 并发执行
    start_time = time.time()

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(process_single_resume, task) for task in tasks]

        for future in as_completed(futures):
            idx, result = future.result()
            results[idx] = result

    elapsed = time.time() - start_time
    print("-" * 50)
    print(f"处理完成，耗时: {elapsed:.1f} 秒")
    print(f"平均速度: {elapsed/total:.2f} 秒/条")

    return results


def main():
    print("=" * 50)
    print("简历筛选系统 - Ollama 并发版")
    print("=" * 50)

    print(f"\n加载数据: {CSV_PATH}")
    df = load_data(CSV_PATH)
    print(f"加载完成，共 {len(df)} 条记录")

    # 准备真实标签
    true_labels = df["筛选结果"].map({"通过": 1, "不通过": 0}).tolist()

    print("\n开始并发处理...")
    results = process_resumes_parallel(df, true_labels)

    df["模型筛选结果"] = results

    df.to_csv(OUTPUT_PATH, index=False, encoding='utf-8-sig')
    print(f"\n结果已保存至: {OUTPUT_PATH}")

    valid_results = [r for r in results if r is not None]
    passed = sum(1 for r in valid_results if r == 1)
    failed = sum(1 for r in valid_results if r == 0)
    error = len(results) - len(valid_results)

    print("\n" + "=" * 50)
    print("统计结果:")
    print(f"  通过: {passed}")
    print(f"  不通过: {failed}")
    print(f"  处理失败: {error}")
    print("=" * 50)


if __name__ == "__main__":
    main()
