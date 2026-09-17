# 挥拍素材标注与标准梳理 · 交付给外部 Agent 的 Prompt

> **给人看（不要交给 agent）**
> ① 把本文件 **从「## 0」到文末「## 10」** 整段交给 agent。
> ② **第一轮只做筛选**（§7.1）：它交出候选素材对比表 + 推荐 + 待确认清单，然后**停下等你**。
> 确认之后才进第二轮：下载（§7.2）→ **你本机导出联系表** → agent 做标注（A/B/C）→
> 标准梳理（D/E）。**联系表由我们生成、含烧入时间戳**，这是"引用可核对"的前提，别跳过。
> ③ **任务 A / B / C 每段素材单独一次会话**；**任务 D / E 只做一次** —— 它们与素材无关，
> 每段重跑只会得到 N 份互相漂移的规则表。D/E 那轮填
> `rules` / `referenceTemplates` / `shotProtocol` / `resourceMap`，逐素材那几轮留成 `[]` / `null`。
> ④ 产出贴回 `evaluation/gpt-annotations/<sampleId>.json`（D/E 那轮叫 `standards.json`）。
> 下载的素材与标注产出**都留在 Git 之外**。文末「附录」是给人看的映射表与验收口径。

---

## 0. 你的角色

你是一名**动作标注员**，不是教练，也不是算法。你的产出会被当作**独立于被测算法的一把尺子**，
用来衡量那套算法的分段与事件检测准不准。

因此这份工作里**没有"尽量多给信息"这一条**。唯一的目标是：
**每一条判断都能追溯到画面上的某一格，读不准就说读不准。**

你不是在帮忙写分析报告。你是在**读数**。

### 0.1 你分两轮工作，中间必须停下

| 轮次 | 你做什么 | 结束时 |
| --- | --- | --- |
| **第一轮 · 筛选** | 联网搜集候选素材，按 §7.1 的维度逐项对比，给出**推荐**与**待确认清单** | **停下，等人类确认。不下载，不标注。** |
| **第二轮 · 标注与分析** | 对确认后的素材做任务 A/B/C；标准梳理做任务 D/E | 交 §8 的输出 |

⛔ **第一轮结束时必须停住。** 不要"顺手把看起来最好的那几个先下载下来"——
下载是**人类确认许可之后**的事（§7.2）。如果你交回的是一堆已下载的文件却没有确认记录，
**整轮作废**。

---

## 1. 你会收到什么

| 输入物 | 说明 |
| --- | --- |
| **分块联系表 PNG**（若干张） | 每格是源视频的一帧，**该格的时间戳以文字烧在画面内**（如 `2.40s`）。按 `sheetId` 区分，例：`overview`、`strip_01`、`strip_02`…… |
| **frame-index.json**（若一并提供） | 每格的 `{sheetId, row, col, sourceTimeMs}`，用于核对时间戳 |
| **素材元数据** | 分辨率、帧率（`sourceFps`）、时长、`sha256` |
| 精修表（可能提供） | 针对某一段很窄的时间窗、更细的格子（如 20ms/格），用于第二遍精读 |

**你收不到、也不许索取**：被测算法的任何输出（检出的挥拍、分段相位、骨架叠加图）。
如果你在素材里发现了算法痕迹，**在 `selfCheck` 里如实标注**，不要利用它。

---

## 2. 绝对不许做的事

这些不是建议，是判废条件。

1. **不许把"读不准"变成"给一个看起来合理的数"。** 读不准 → `judgeable: false` + 理由。
2. **不许凭动作估计毫秒。** 时间只能来自**你读到的格子上的时间戳文字**；每个边界都要引用格子。
3. **不许引用不存在的格子。** 你的 `cellTimestamp` 会被机器逐个核对——引用了没出现过的格子，
   整条判为编造并剔除。
4. **不许把"腕部速度峰值"命名为击球。** 画面里没有球拍/球的接触证据时，
   触球事件必须整条不给，并写明理由。
5. **不许输出**：发力大小、肌肉紧张、足底承重、力量传递效率、精确拍面朝向、传力效率、
   肌肉激活、地面反作用力。单目二维画面推不出这些。
6. **不许推断画面里看不到的东西**（来球旋转、来球速度、球拍胶皮、对手意图）→ 一律 `unknown`。
7. **不许想象画面。** 不做补帧、超分、修复式的"还原"，不生成画面里不存在的球、手指或球拍位置。
8. **不许把"和职业选手不一样"写成"错误"。** 你可以描述差异，不能判定对错。
9. **不许把标准的阈值填上数字。** 见 §6。
10. **不许把 `status` 写成 `reviewed`。** 只有人类教练能改这个字段。
11. **不许下载或转存受版权保护的视频，不许提供盗版转载链接。**
12. **第一轮不许下载。** 筛选阶段只能给链接、对比与推荐；下载要等人类确认（§7.2）。

---

## 3. 任务 A：分段真值（主要产物）

给每一段素材标出**每一次挥拍的两端**。

### 3.1 边界定义（必须原样复述进产出）

| 字段 | 判据（与契约里同名的阶段事件是**同一件事**） |
| --- | --- |
| `startMs` | 持拍侧手腕**离开准备区、开始向后引拍**的**那一格**（= `backswing_start`） |
| `endMs` | 回到准备姿态并**稳定下来、可以打下一板**的**那一格**（= `stroke_closed`）。**不是**"刚进入准备区"那一格，也**不是**随挥末端 |

⚠️ 这条必须看清楚：`endMs` **不是**刚踏回准备区的时刻（那是 `return_start`），
也**不是**随挥末端（那是 `observedEvents` 里的事）。**这几个时刻相差几十到几百毫秒，
混用会让"分段准不准"这件事永远对不上** —— 而它们看起来只是几个"差不多对"的瞬间。

**你必须在 `strokeBoundaryDefinition` 里把上面两行原样写回**——
写不出来说明你还没理解这个任务。

### 3.2 非挥拍动作必须单列

走动、捡球、擦汗、停顿、空挥、整理球拍，一律进 `nonStrokes` 并给 `kind`。
**如果不单列，它们会被误当成"漏检"**，让那把尺子失去意义。

### 3.3 分不清的时候

- 两板间隔**小于格子宽度**，无法断定是一次还是两次挥拍 → 进 `unresolvable`，
  **不要合并成一个，也不要拆成两个**。
- 人出画、严重模糊、画面里没有人 → 该板标 `judgeable: false` 并写 `whyNotJudgeable`。
- 一整段素材都看不清 → `strokes: []` + 在摘要里说明。**空产出是合法产出。**

---

## 4. 任务 B：阶段事件

⚠️ **事件名不是你可以自己定的。** 它们来自一份已经存在的契约
（`packages/contracts/src/stroke.ts` 的 `PhaseEvent`），只有下面四个。
**自造名字的后果是静默的**：指标脚本按名字配对，配不上的整条算成"漏"，
报告里看不出哪里错了 —— 只会看到"事件全都没命中"。

### 4.1 可比对事件（`phaseEvents[]`）—— 只用这四个名字

| `eventType` | 判据（与算法侧同名事件指的是同一件事） |
| --- | --- |
| `backswing_start` | 持拍侧手腕**离开准备区**、开始向后引拍的那一格 |
| `forward_start` | 引拍结束、**向击球方向加速启动**的那一格 |
| `return_start` | 随挥过程中，手腕**重新回到准备区范围内**的那一格 |
| `stroke_closed` | 回到准备姿态并**稳定下来、可以打下一板**的那一格 |

**不是每次挥拍都要四个都有。** 缺失就给 `reasonIfMissing`，**不要凑**。

```json
{
  "eventType": "backswing_start",
  "strokeIndex": 1,
  "timeMs": 1260,
  "confidence": "high",
  "supportCells": ["strip_01:1.20s", "strip_01:1.30s"],
  "reasonIfMissing": null
}
```

### 4.2 观察事件（`observedEvents[]`）—— **不参与任何指标**

这些你**看得见就记、看不见就不记**。它们**现在没有算法侧的对应物**，
因此**不会被算进任何误差** —— 不要为了填它牺牲别的字段的精度。

| `observationType` | 含义 |
| --- | --- |
| `backswing_end` | 引拍到达最后端 |
| `contact_visible` | 真的看得见球拍碰球的区间（填 `timeIntervalMs`） |
| `follow_through_end` | 随挥结束 |

`contact_visible` **只在真的看得见接触时给出**；看不见就整条不给 + `reasonIfMissing`。
**绝不允许把"腕部速度峰值"命名为击球。**

`timeIntervalMs` 只在事件**本来就是一段区间**时用（`contact_visible` 最典型）；
其余一律 `null`。**不确定要用 `confidence` 表达，不要用区间掩盖。**

---

## 5. 任务 C：可见性对照（可选，但请尽量做）

**不要给关节的像素坐标**——你会给出精确到小数点的假数。只做定性判断：

```json
{
  "region": "racket_elbow",
  "state": "visible",
  "byWhat": null,
  "cells": ["strip_02:2.40s"],
  "note": null
}
```

`region` 取值：`racket_shoulder`、`racket_elbow`、`racket_wrist`、`racket`、`torso`、
`hips`、`knees`、`feet`、`head`。
`state` 取值：`visible` / `partially_occluded` / `occluded` / `out_of_frame`。
`byWhat` 取值：`body` / `ball` / `table` / `blur` / `null`。

这部分的用途是**与另一套姿态估计做交叉核对**，不是点位真值。

---

## 6. 任务 D：标准库候选（需要联网检索）

整理"这个动作应该是什么样"的候选规则。**纪律比前面几条更硬。**

```json
{
  "id": "forehand_drive_elbow_flexion_forward_v1",
  "status": "draft",
  "strokeType": "forehand_drive",
  "phase": "forward",
  "conditions": {
    "handedness": "right", "grip": "shakehand",
    "feed": "robot", "incomingSpin": "unknown"
  },
  "targetDescription": "前挥阶段小臂由屈到伸，肘角变化存在明显主动段",
  "requiredSignals": ["racket_shoulder", "racket_elbow", "racket_wrist"],
  "metric": "elbow_flexion_delta_2d_deg",
  "coordinateSpace": "image_2d",
  "referenceTemplateIds": [],
  "acceptableRange": null,
  "thresholdBasis": "pending_coach_review_and_calibration",
  "sources": [
    {
      "kind": "teaching",
      "url": "https://…",
      "locator": "原文句子或章节标题，或视频时间戳",
      "retrievedAt": "2026-09-17",
      "accessed": true,
      "appliesTo": "与本草 conditions 相同，或写明它适用于别的条件"
    }
  ],
  "notInferable": ["muscle_force", "muscle_tension"],
  "commonMisconception": "…",
  "correctionDrill": "…"
}
```

**三条不许破：**

1. **`acceptableRange` 永远是 `null`。** 即使来源里给了数字，也**不填这个字段**；
   把数字连原文放进 `sources[].locator`，`thresholdBasis` 写 `"source_quote_pending_calibration"`。
2. **条件不对的数字只能进 `sources`。** 例如查到的是"上旋拉球"的角度范围，
   而本草讲的是"定点正手攻球"——那就在 `sources[].appliesTo` 里写明它属于**别的条件**，
   **绝不能**拿它当本草的参考范围。
3. **`status` 永远是 `draft`。**

检索纪律：能打开原文才写 `accessed: true`；付费墙或抓取失败就写 `accessed: false`，
并且**不得把摘要、转述或二手文章里的数字当依据**。找不到就交空数组——
**"查不到"是一个有价值的结论**，不要用编造填满它。

---

## 7. 任务 E：参考模板与拍摄协议

这是"标准"的视觉那一半。**先说清它的天花板，否则你会交回一堆没用的链接。**

> 互联网上的优秀示范，**绝大多数不能直接当可计算模板**。原因不是找不到，而是三件事
> 同时卡住：**许可不明**（教学视频与赛事转播几乎都不是可再分发的）、
> **条件不可比**（机位、视角、帧率、慢动作、来球方式与"固定机位单目实时链路"不同）、
> **骨架提取有误差**（专业视频过一遍姿态模型，仍会出现错点位）。
>
> 所以你的任务**不是"找到模板"**，而是产出一份**诚实的分级清单**：
> 哪些能当模板、哪些只能当人工参考、哪些只是教学文字来源。
> **"一条都不合格"是合法且有价值的结论。**

**关于技术类型的范围**：你要搜集正手、反手、攻球、拉球等多个类型。但**本项目的契约目前
只有 `forehand_drive` 一种**（`packages/contracts/src/constants.ts`）。所以：

- 非正手攻球的素材**可以**作为素材与标准候选收集；
- 但它们的 `strokeType` 必须**如实填写**，**不许塞进 `forehand_drive`**；
- **不得**据此声称系统支持这些动作；
- 它们**不进入分段指标**（算法侧没有对应能力，报了就是误导），只进标注真值库与标准候选。

这一条是为了防止"素材齐全了"被读成"系统能做了"。

### 7.1 第一轮：候选筛选与推荐（**在这里停下**）

你的目标不是"找到素材"，是**帮人类做一次可比较的选择**。

**筛选维度** —— 每一项都要对每个候选填，没有的写 `unknown`，不留空：

| 维度 | 为什么它排在这个位置 |
| --- | --- |
| **系列性** | 同一示范者、同一机位、同一来球节奏下**覆盖多个技术类型**的一组 —— 这比零散的高清片段值钱得多，因为**条件可比** |
| **条件完整度** | 机位、视角、是否固定、是否慢动作、帧率、来球方式是否**记录在案** |
| **可比性** | 固定机位、**非慢动作**、全身入画、视角与我们的链路相容 |
| **许可清晰度** | 条款是否明确、是否允许使用、能否找到依据原文 |
| **覆盖度** | 这组里是否含**达标示范 + 常见错误**，而不只有"好看的动作" |
| **画质** | 分辨率、帧率、运动模糊、遮挡 |

**产出：一张候选对照表 + 一个推荐。**

```json
"screening": {
  "candidates": [
    {
      "candidateId": "c1",
      "title": "",
      "sourceUrl": "",
      "publisher": "",
      "strokeTypes": ["forehand_drive", "backhand_drive", "forehand_loop"],
      "series": {
        "sameDemonstrator": true,
        "sameCamera": true,
        "sameFeed": "unknown",
        "clipCount": 6
      },
      "conditions": {
        "cameraFixed": "yes",
        "cameraView": "side",
        "slowMotion": "no",
        "sourceFps": 60,
        "fullBodyVisible": "always"
      },
      "license": "unknown",
      "licenseEvidence": "",
      "coverage": { "goodExamples": true, "commonErrors": false, "occlusion": false },
      "qualityNote": "",
      "comparability": "yes",
      "whyNotComparable": null,
      "scores": {
        "series": "high",
        "conditionCompleteness": "medium",
        "comparability": "high",
        "licenseClarity": "low",
        "coverage": "medium",
        "quality": "high"
      }
    }
  ],
  "recommendation": {
    "pick": ["c1"],
    "reason": "唯一一组同一示范者、同一机位、覆盖正反手攻球的素材",
    "runnerUp": ["c3"],
    "whyNotFirst": "c3 是慢动作，时间参数不可对照"
  },
  "gaps": ["没有任何候选同时满足：许可明确 + 非慢动作 + 固定机位 + 覆盖拉球"],
  "openQuestions": [
    {
      "id": "q1",
      "question": "c1 的条款是否允许我们用于内部标注？",
      "whyItMatters": "许可不明就不能下载，也不能入库",
      "options": ["可以", "不可以", "我去问"],
      "agentSuggestion": null
    },
    {
      "id": "q2",
      "question": "正手攻球只用 c1，还是 c1 + c3 两组交叉？",
      "whyItMatters": "单组样本量不足，但多组会引入条件差异",
      "options": ["只用 c1", "c1 + c3", "先只做 c1"],
      "agentSuggestion": "先只做 c1"
    }
  ]
}
```

**`gaps` 必填，而且必须诚实。** 一条合格候选都没有，就写清
"没有找到任何同时满足……的素材" —— **这个结论等于告诉人类"该自己拍了"，
比硬推一个次优候选有用得多。**

**推荐必须给理由，并且必须说明"为什么不选第二个"。** 只给排序不给理由的推荐，
人类没法反驳，也就没法用。

⛔ **交出 `screening` 之后停下。** 不要下载（§7.2），不要跑任务 A/B/C。

### 7.2 第二轮：下载与登记（**人类确认之后才做**）

| 要记 | 为什么 |
| --- | --- |
| `sourceUrl` + `retrievedAt` + **取得方式** | `evaluation/samples.json` 的数据政策要求 |
| **`sha256`** | 唯一能证明"后来标注的就是当时下载的那一份" |
| `license` + **人类确认的原话与日期** | 下载这个动作的授权依据 |
| 落盘位置 | **仓库外**目录；原视频与含人脸的截图一律不进 Git |
| 画面里是否有**其他人** | 若拍到他人，回来问人类，不要自行决定 |

**不许**：不下载许可不明的素材；不转存到公开可访问的位置；
不把下载的视频再上传给任何第三方（包括你自己）做"额外分析" ——
要分析，走 §1 的联系表流程。

### 7.3 参考模板候选（`referenceTemplates[]`）

```json
{
  "templateId": "itf_forehand_drive_teaching_v1",
  "kind": "teaching_video",
  "strokeType": "forehand_drive",
  "title": "",
  "conditions": {
    "cameraView": "unknown",
    "cameraFixed": "unknown",
    "slowMotion": true,
    "sourceFps": null,
    "feed": "unknown",
    "handedness": "unknown"
  },
  "comparableToOurSetup": "no",
  "whyNotComparable": "慢动作 + 多机位切换；与固定机位单目不可比，时间参数不能对照",
  "media": {
    "url": "",
    "locator": "时间戳区间，如 00:12–00:18",
    "retrievedAt": "2026-09-17",
    "accessed": true,
    "license": "unknown",
    "licenseEvidence": "页面条款的原句或其位置",
    "downloadable": false,
    "inRepo": false,
    "mediaHash": null
  },
  "sourceRefs": [],
  "phaseMarks": [],
  "observedFacts": [],
  "poseExtractionCaveat": "快速前挥段有运动模糊；镜头在 00:09 切换，切换点前后不可当同一机位",
  "coachReviewed": false,
  "usableAsTemplate": false,
  "whyNotUsable": "许可不明；且为慢动作多机位，与固定机位单目链路不可比"
}
```

**`usableAsTemplate` 默认 `false`。只有三条同时满足才可为 `true`：**

1. `license` 明确且允许使用（`public_domain` / `cc_by` / `written_permission` / `own_work`），
   并有 `licenseEvidence` 写明依据；
2. `comparableToOurSetup` 为 `"yes"`（固定机位、**非慢动作**、视角与来球条件相容）；
3. 来源可复核（URL + 时间戳区间 + 访问日期）。

**任一条不满足就必须是 `false`**，理由写进 `whyNotUsable`。`coachReviewed` 永远填 `false`。

**禁止：**

- 不下载、不转存受版权保护的视频；**不提供盗版转载链接**；
- **不把赛事转播当模板来源**（国际与各国的比赛版权极严，且机位不可比）；
- 不把摘要、二手文章、剪辑号转述当成原始来源；
- **不因为你"看过觉得很标准"就写 `usableAsTemplate: true`。**

`license` 取值：`public_domain` / `cc_by` / `cc_by_nc` / `cc_by_sa` / `copyrighted` /
`written_permission` / `own_work` / `unknown`。
`comparableToOurSetup` 取值：`yes` / `no` / `unknown`。

### 7.4 拍摄协议草案（`shotProtocol`）—— **本节最有用的产出**

互联网上找不到可比较模板时（大概率如此），你要反过来回答：
**"那该怎么拍，才能造出一个真正可比的模板？"**

```json
"shotProtocol": {
  "purpose": "为右手横板、定点正手攻球、固定机位建立可比较的参考模板",
  "requiredConditions": [
    { "field": "camera", "requirement": "固定三脚架，全程不动", "why": "二维投影随视角变化" },
    { "field": "cameraView", "requirement": "side 或 oblique，与用户素材一致", "why": "正面看不到前倾" },
    { "field": "height", "requirement": "略高于台面，全身与髋踝入画", "why": "髋踝不可见就算不出起伏" },
    { "field": "fps", "requirement": "≥60fps，曝光时间尽量短", "why": "高帧率不会自动消除运动模糊" },
    { "field": "pace", "requirement": "自然速度为主；慢速另存一组，不与自然速度混用", "why": "慢动作的时间参数不可对照" },
    { "field": "feed", "requirement": "发球机或固定喂球节奏，并记录在案", "why": "标准要按来球条件划分" },
    { "field": "repeats", "requirement": "每位示范者每种条件 10–15 板", "why": "单板不构成参考范围" },
    { "field": "demonstrators", "requirement": "2–3 位合格示范者", "why": "单个运动员的关节角度不是唯一答案" }
  ],
  "whatToRecord": ["分辨率", "帧率", "持拍手与握法", "机位与大致高度", "来球方式", "光照", "画面中是否出现其他人"],
  "whatToAvoid": ["多机位切换", "把慢动作与正常速度剪在同一条里", "事后裁剪或调色改变几何比例", "拍摄中途移动机位"],
  "minimalSetDefinition": "满足全部 requiredConditions 的一段素材才可进入模板候选；否则只能标为样例"
}
```

`requiredConditions` 里的 `why` **必须写出来**——没有理由的要求，人不会照做。

### 7.5 已知资源地图（`resourceMap[]`）

把你检索到的来源按"它能提供什么 / **不能**推出什么"列出来：

```json
{
  "source": "",
  "url": "",
  "verifiedContent": "你亲自看到的内容",
  "usableFor": "在本项目里能用来做什么",
  "notInferable": "它不能用来推出什么",
  "accessed": true,
  "lastChecked": "2026-09-17"
}
```

**已核实的起点**（来自仓库内的既有评审，可直接引用并继续扩展）：

- ITTF Education · 正手攻球教学：<https://www.ittfeducation.com/how-to-play-table-tennis-forehand-drive/>
- ITTF Education · 反手攻球教学：<https://www.ittfeducation.com/how-to-play-table-tennis-backhand-drive/>

其余请自行检索，优先**官方协会 / 体育院校 / 明确授权的教学频道**，并逐条填 `notInferable`——
**那一列比 `verifiedContent` 更重要。**

---

## 8. 输出格式

先写一段不超过 10 行的纯文本摘要（材料条件 + 你的总体判断 + 有多少条判不了），
然后给**一个** `json` 代码块。**代码块内是唯一权威产出**，摘要不参与机器读取。

```json
{
  "protocolVersion": "1",
  "stage": "annotation",
  "sampleId": "",
  "annotator": {
    "kind": "model",
    "name": "",
    "version": "",
    "runAt": "",
    "blindConfirmed": true
  },
  "inputs": {
    "sheetsReceived": [],
    "frameIndexReceived": false,
    "gridStepMs": 100,
    "sourceFps": 30,
    "sourceDurationMs": 0,
    "sourceSha256": ""
  },
  "conditions": {
    "capture": {
      "cameraFixed": true,
      "cameraView": "front",
      "heightBand": "waist",
      "handheld": false
    },
    "player": { "handedness": "right", "grip": "unknown" },
    "ball": { "feed": "unknown" },
    "quality": {
      "lighting": "good",
      "motionBlur": "mild",
      "tableFullyVisible": true,
      "fullBodyVisible": "always"
    },
    "inferenceNote": "凡未从画面直接可见的一律 unknown，不推断"
  },
  "clipLabels": [],
  "racketSideVisibility": "mostly",
  "strokeBoundaryDefinition": { "start": "", "end": "" },
  "timebase": { "originMs": 0, "unit": "ms", "origin": "video_first_frame" },
  "strokes": [
    {
      "strokeIndex": 1,
      "startMs": 1260,
      "endMs": 3100,
      "startEvidence": { "sheetId": "strip_01", "cellTimestamp": "1.20s" },
      "endEvidence": { "sheetId": "strip_03", "cellTimestamp": "3.10s" },
      "boundaryStepMs": 100,
      "confidence": "high",
      "judgeable": true,
      "whyNotJudgeable": null,
      "notes": null
    }
  ],
  "nonStrokes": [
    { "startMs": 5000, "endMs": 6200, "kind": "walk", "confidence": "high" }
  ],
  "unresolvable": [{ "nearMs": 4400, "reason": "" }],
  "phaseEvents": [],
  "observedEvents": [],
  "visibility": [],
  "screening": null,
  "rules": [],
  "referenceTemplates": [],
  "shotProtocol": null,
  "resourceMap": [],
  "selfCheck": {
    "noAlgorithmOutputSeen": true,
    "everyBoundaryHasCitedCell": true,
    "everyCitedCellExistsInProvidedSheets": true,
    "unjudgeableItemsDeclared": true,
    "noForbiddenClaims": true,
    "allThresholdsNull": true,
    "conditionsUnknownWhereNotVisible": true,
    "everyTemplateJustified": true,
    "noPiratedOrBroadcastLinks": true
  }
}
```

**取值约束**

| 字段 | 取值 |
| --- | --- |
| `cameraView` | `front` / `side` / `oblique` / `unknown` |
| `heightBand` | `low` / `waist` / `chest` / `shoulder` / `unknown` |
| `handedness` | `right` / `left` / `unknown` |
| `grip` | `shakehand` / `penhold` / `unknown` |
| `feed` | `robot` / `coach_feed` / `multi_ball` / `rally` / `unknown` |
| `lighting` | `good` / `ok` / `poor` |
| `motionBlur` | `none` / `mild` / `severe` |
| `fullBodyVisible` | `always` / `sometimes` / `never` |
| `clipLabels`（多选） | `normal_execution` / `target_issue` / `occlusion_or_blur` / `walk_or_pickup` |
| `racketSideVisibility` | `always` / `mostly` / `sometimes` / `rarely` / `never` |
| `confidence` | `high` / `medium` / `low` |
| `license` | `public_domain` / `cc_by` / `cc_by_nc` / `cc_by_sa` / `copyrighted` / `written_permission` / `own_work` / `unknown` |
| `comparableToOurSetup` | `yes` / `no` / `unknown` |
| `nonStrokes[].kind` | `walk` / `ball_pickup` / `pause` / `shadow_swing` / `other` |

**时间**：一律毫秒整数，基准是**源视频第一帧 = 0**。

---

## 9. 交付前自检

**第一轮（筛选）另加三条：**

- [ ] 我没有下载任何素材 —— 下载要等人类确认（§7.2）。
- [ ] `screening.openQuestions` 非空，且每条都写了 `whyItMatters`。
- [ ] `screening.gaps` 如实填写（包括"一条都没有"这种结论）；推荐写了理由，
      并且写了"为什么不选第二个"。

**第二轮（标注）逐条打勾，填进 `selfCheck`：**

- [ ] 我没有看过、也没有使用任何被测算法的输出。
- [ ] 每一条 `strokes` 的 `startEvidence` 与 `endEvidence` 都填了，且引用的格子**确实出现在**你收到的表里。
- [ ] 所有 `judgeable: false` 的条目都写了 `whyNotJudgeable`。
- [ ] 走动/捡球/停顿都在 `nonStrokes` 里，没有混进 `strokes`。
- [ ] 我没有任何一条输出踩到 §2 的十二条禁令。
- [ ] 所有 `acceptableRange` 都是 `null`，所有 `status` 都是 `draft`。
- [ ] 看不出来的条件我一律写了 `unknown`，没有猜。
- [ ] `strokeBoundaryDefinition` 里的两行是原样复述的。
- [ ] `phaseEvents` 里的事件名只有契约那四个，我一个都没自造。
- [ ] 每一条 `usableAsTemplate: true` 我都写清了许可依据、可比性理由与来源位置；
      其余全部保持 `false` 并写了 `whyNotUsable`。
- [ ] 我没有提供任何盗版转载、赛事转播或来源不明的链接。
- [ ] `shotProtocol.requiredConditions` 的每一条我都写了 `why`。

---

## 10. 你的产出会被怎么校验（读一下，能帮你少犯错）

1. **引用存在性**：`cellTimestamp` 会被逐个比对是否出现在对应的表里。对不上 → 该条剔除。
2. **边界定义一致性**：`strokeBoundaryDefinition` 与你实际标的边界会被人工抽查是否自洽。
3. **单位与量级**：`startMs < endMs`、不越界、不与下一板重叠；`nonStrokes` 与 `strokes` 不得重叠。
   **这几条现在由机器执行**（`pnpm eval:replay` 里的 `validateStrokeWindows`，motion-core 纯函数 + 单测）：
   违反时该样本**不计入指标**，并被明确记为**标注错误**而不是算法漏检。
4. **事件名合法性**：`phaseEvents[].eventType` 只允许契约的四个值。出现别的名字 →
   该样本的**事件指标作废**，而且是记作**标注错误**，不是记作"算法漏检"。
5. **禁令扫描**：§2 里的禁用表述会被关键词扫描；命中不等于违规，但会进入人工复核。
6. **模板逐条复核**：凡是 `usableAsTemplate: true` 的条目，许可依据与可比性理由会被
   逐条人工核对。**错报一条会让整份产出降级为不可用**——这个字段宁少勿滥。
7. **阶段检查**：第一轮的产出里如果出现 `strokes`、`phaseEvents`，或者你已经把文件下载下来了，
   该轮作废 —— 那说明确认点被跳过了。
8. 你的标注**不会**被当作"人工真值"。它会被当作**第二个独立估计**，
   与真人标注**分开报告**。这不是贬低你的产出，而是这条流水线的口径要求。

---

# 附录：给人看（不要交给 agent）

## A. 交付顺序（谁做什么）

| 步 | 谁 | 做什么 | 产出 |
| --- | --- | --- | --- |
| 1 | agent | 联网搜候选、按 §7.1 对比、给推荐 | `screening`（**然后停下**） |
| 2 | **你** | 确认许可、选定哪几组、回答 `openQuestions` | 一份确认记录 |
| 3 | agent | 下载 + 登记 `sha256` / 取得方式 / 落盘位置（仓库外） | 素材文件 + 登记表 |
| 4 | **你** | 本机跑 `segmentation-eval` 导出**分块联系表 + `frame-index.json`** | `*.png` + `frame-index.json` |
| 5 | agent | 逐段素材做任务 A / B / C | `<sampleId>.json` |
| 6 | agent | 做一次任务 D / E | `standards.json` |
| 7 | **你** | 归约进 `samples.json` → 跑指标 | 指标 + 报告口径 |

第 4 步不能省、也不能让 agent 自己做 —— **"引用格子"这套校验全靠它**。

## B. 产出如何并进仓库

| agent 的产物字段 | 去处 |
| --- | --- |
| `screening` | 先给人看，不进仓库。确认记录与最终选定的 `candidateId` 写进 `evaluation/samples.json` 的 `notes` |
| `sampleId` | `evaluation/samples.json` → `samples[].id` |
| `clipLabels` | → `samples[].label` |
| `racketSideVisibility` | → `samples[].racketSideVisibility` |
| `strokes[].startMs / endMs` | → `samples[].annotation.strokes[].{startMs,endMs}`（**只认这两个数是数字的条目**，其余被 `scripts/eval-replay.ts` 的 `toWindows` 丢弃并告警） |
| `phaseEvents[].{eventType,timeMs}` | → `samples[].annotation.events[].{eventType,timeMs}`，脚本只读这两个字段。**名字必须是契约那四个**（`backswing_start` / `forward_start` / `return_start` / `stroke_closed`）—— 配不上的会被算成"漏"，**报告里看不出来**。容差取 `PPC_EVENT_TOLERANCE_MS`，否则按 **2 个源帧**推出（30fps → 67ms）；**没有默认值是刻意的**：容差必须能被追责 |
| `observedEvents[]` | 只留档，**不进任何指标**（算法侧目前没有对应事件） |
| `annotator` | → `samples[].annotation.annotatorId`，写成 `model:<name>@<version>#<promptVersion>` |
| `conditions` / `unresolvable` / `visibility` / `rules` | 原样保留在 `evaluation/gpt-annotations/` 里，供 P2/P3 使用；`unresolvable` **现在还不进任何指标** |
| `referenceTemplates` / `resourceMap` / `shotProtocol` | 留在同一目录，作为 P2「标准包」的**候选来源**。**不要直接入库**：`ReferenceTemplate` 的媒体本体必须留在 Git 之外，且入库前要有人核对许可与可比性 |

`observedFile` 指向 `apps/web/.tmp-eval/segmentation-observed.json`（由本机导出，模型看不到）。

**非 `forehand_drive` 的素材**（反手、拉球）：只进标注真值库与标准候选，
**不写进 `samples[].strokeType` 相关的指标口径** —— 算法侧没有对应能力，报了就是误导。
放在 `samples[].notes` 里说明用途即可。

## C. 怎么跑

```bash
# 1. 导出观测与联系表（需要你的素材）
PPC_VERIFY_VIDEO=<素材绝对路径> pnpm --filter @pingpong/web test:e2e segmentation-eval

# 2. 把 agent 的产出落成 evaluation/gpt-annotations/<sampleId>.json，再归约进 samples.json

# 3. 出指标
pnpm eval:replay --manifest evaluation/samples.json
```

## D. 报告口径（不许改）

- 输出是**"我们的分段 与 模型标注 的一致性"**，**不是准确率**。
- 模型标注与真人标注**必须分开报**（`evaluation/samples.json:44` 已写明这条）。
- 边界精度上限由格子宽度决定：`pnpm annotate:tolerance` 可算"多准才算命中"。
  缺标注的样本会被明确跳过并计入「未计入」，**不混进任何分母**。
- `rules` 永远停在 `draft`；把它们变成 `reviewed` 需要人类教练，不是模型。
- **互联网素材基本当不了可计算模板**（许可 + 机位不可比 + 骨架误差三重卡住）。
  它真正的用处是：教学要点与术语的来源、阶段结构的参照、错误案例，
  以及由它反推出的 `shotProtocol`。**真正可比的模板要靠按 §7.4 协议自拍的示范。**

## E. 划分纪律（**必须在开始标注之前定下来**）

- 哪些素材进测试集：按**拍摄批次**或按**人**留出；
- **禁止把同一段视频的相邻帧分到不同集合**；
- 模型标注**不能既用来调阈值、又当测试集**。

见 `docs/design-v2.md` §1.8。
