# 18 天执行计划（2026-10-05 → 10-24 03:00 北京时间截止）

## 第 1–2 天（10-05 ~ 10-06）：账号与跑通
- [ ] Devpost 注册比赛（amazonappdev2026.devpost.com 点 Register）
- [ ] Ring 开发者账号 + Playground 生成 token，跑通官方 helloworld（webhook/快照二选一跑起来）
- [ ] 建 GitHub repo（public + 开源 license，一石二鸟备 Open Source 项）
- [ ] 申请 $150 AWS credits（官方表单）

## 第 3–5 天（10-07 ~ 10-09）：webhook 管道
- [ ] Supabase Edge Function `ring-webhook`：接收 motion/ding 事件 → 调 Ring API 取快照 → 入库（事件表）
- [ ] 模拟器事件发生器（本地无硬件测试用）
- [ ] webhook 签名校验（按官方文档来）

## 第 6–9 天（10-10 ~ 10-13）：AI 识别 + 告警
- [ ] Edge Function `analyze-snapshot`：Bedrock Nova Lite 看图 → 输出 {人/包裹/宠物/车辆/无}
- [ ] 告警引擎规则：
  - 包裹出现（之前无→有）：📦 包裹送达提醒
  - 包裹消失（有→无）+ 有人：⚠️ 包裹可能被取走
  - 同一人徘徊 >10 分钟：👀 门口徘徊提醒
  - 夜间（23:00–06:00）移动：🌙 夜间活动提醒
- [ ] 推送通道（先 Web 推送，简单可用）

## 第 10–12 天（10-14 ~ 10-16）：Dashboard
- [ ] Next.js 实时看板：事件时间线 + 快照 + AI 标签 + 告警横幅
- [ ] 按官方 UX design guide 做一版干净的界面

## 第 13–14 天（10-17 ~ 10-18）：联调 + 拍 demo
- [ ] 模拟器全链路联调（事件→快照→识别→告警→看板）
- [ ] 写 3 分钟 demo 脚本并录制（英文，YouTube 公开）

## 第 15–16 天（10-19 ~ 10-20）：材料
- [ ] repo 整理：README、架构图、运行说明
- [ ] product feedback（每个用到的工具/API：好用在哪、哪里卡）
- [ ] friction log（+10% 评审加分，别漏）
- [ ] Open Source mini：整理一个可独立开源的 webhook 工具小库，提 PR/发版

## 第 17–18 天（10-21 ~ 10-23）：提交
- [ ] Devpost 提交：描述 + repo + 视频 + feedback + 赛道选择
- [ ] 私有 repo 记得加 Amazon 那 6 个 reviewer（如果选私有；推荐 public）
- [ ] 提前一天提交，留 buffer

## 风险
- Ring API 沙盒/模拟器的事件 fidelity——第 2 天跑通 helloworld 时验证
- Bedrock 费用——$150 credits + Nova Lite 最便宜档，够用
- 时间紧——砍 Dashboard 花哨功能，保 webhook→识别→告警主链路
