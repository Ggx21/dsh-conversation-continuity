# dsh-conversation-continuity

给 DeepSeek Harness 的聊天伙伴使用的上下文压缩插件。摘要同时保留人物关系、真实互动的语感和纠正的适用范围，让聊天在长会话压缩后能够接着聊。

例如，用户说“这句话不是对你说的”，检查点会记录对应的单次纠正及情境。用户明确说“以后不要把工作消息转发到其他群”时，则记录为有明确范围的长期约定。摘要里的互动例句取自可见原话。

## 功能

- 用聊天摘要模板保留人物关系、称呼、近期趣事、情绪变化和 2–4 组实际互动原话。
- 区分单次纠正、暂时情绪、明确长期约定，以及旧摘要中缺少原话支持的概括。
- 加入一段固定提示，提醒当前会话沿用已有角色和相处方式，在认真回答后自然继续聊天。
- 保留技术任务确实需要的参数、文件路径、结果、任务标识和未完成事项。
- 继承官方 `BasicCompactionEngine` 的压缩阈值、最近原文保留、工具配对、溢出恢复和持久化流程。

每次压缩调用一次宿主 LLM，沿用原来的消息前缀和工具声明。日常回复会多携带一小段固定提示。模型供应商仍按实际 token 和其价格计费。

## 兼容性

已验证 DeepSeek Harness **0.2.2-rc.3**、Node.js **24.21.0**，以及 `deepseek-account` 路由下的 `deepseek-flash`。宿主依赖锁定到该 DSH 版本，升级宿主后需要重新核对接口。

插件复用当前角色设定，可与人设、心情和长期记忆插件配合。它生成的是会话检查点，长期记忆仍由已安装的记忆插件管理。人物关系、规则范围和语感的保留依赖模型对模板的理解，实际聊天效果需要在各自场景中观察。

## 安装

先确认当前 DSH 版本为 `0.2.2-rc.3`，并备份 profile。下例中的路径需要替换为自己的安装位置。

```bash
dsh plugin --profile web add github:Ggx21/dsh-conversation-continuity#v0.1.0

node /path/to/profile/node_modules/dsh-conversation-continuity/scripts/install.js \
  --profile-dir /path/to/profile \
  --runtime-dir /path/to/runtime/node_modules
```

`--profile-dir` 指向同时包含 `package.json` 和 `cordis.patch.yml` 的目录，通常为 `~/.dsh/profiles/web`。`--runtime-dir` 指向能解析宿主 `@deepseek-ai/dsh-web-app` 的 `node_modules` 目录。已经显式配置全部预设插件列表时，可以省略 `--runtime-dir`。

安装器修改预设内 `compaction-basic` 槽位的包名，保留该槽位的配置和其他插件，并自动保存权限为 `0600` 的配置备份。安装器支持重复运行和 `--dry-run`。发现其他压缩后端或不完整的预设覆盖时，会提示需要手工配置。

DSH 将压缩后端放在各个 agent preset 中，因此安装包之后还需要执行这一步配置。完成后重启对应 DSH 进程。

## 手动配置

也可以在已有预设的 `config.plugins` 中找到 `compaction` 分组，将其中的引擎改为下面的形式。合并到已有插件列表时保留其他条目。

```yaml
- id: compaction-basic
  name: dsh-conversation-continuity
  config:
    auto: true
    thresholdRatio: 0.12
    retainTokens: 32000
    headroomTokens: 8192
    maxTokens: 4096
    compactionRetries: 0
    maxOverflowRetries: 1
```

这些数字是针对 1M 上下文模型的一组示例。`thresholdRatio` 还会受可用容量、输出预留和安全余量约束。安装器保留现有数值，实际阈值由配置决定。`retainTokens` 与 `retainRatio` 二选一。精确 provider/model 的 `modelPolicies` 覆盖继续生效。

自动压缩保留配置指定的最近原文预算。宿主的手动 `/compact` 命令会压缩全部可压缩历史，按宿主原有语义执行。

## 检查与回滚

重启后可在新一轮请求的系统提示中检查 `## 对话的延续`。下一次压缩产生的检查点应包含六个部分。

1. 人物与关系
2. 相处方式与语感
3. 有效约定与纠正范围
4. 近期话题与共同经历
5. 当前任务与待办
6. 来源与不确定事项

固定提示通过宿主的系统提示分段接口注册。配置了完整替代系统提示的预设可能屏蔽这一分段，摘要模板仍由压缩引擎使用。

恢复官方引擎可运行下列命令，然后重启 DSH。也可以从安装器输出的备份恢复整个 profile patch。

```bash
node /path/to/profile/node_modules/dsh-conversation-continuity/scripts/install.js \
  --profile-dir /path/to/profile --uninstall
```

已生成的检查点继续作为历史存在。插件会在后续压缩时生成新的模板内容。实际的、由用户确认的长期要求继续以原话和适用范围为准。

## 开发与验证

```bash
npm install --ignore-scripts
npm test
npm pack --dry-run
```

回归检查覆盖单次压缩调用、前缀与工具历史保留、输出截断、异常流、结构不完整、模型策略覆盖，以及安装幂等和回滚。使用自有宿主依赖运行时，应确保测试解析到与宿主相同的依赖实例。

建议再用独立工作区做合成对话验证，通过原生 `/compact` 生成检查点，然后核对局部纠正、长期规则和互动原话。正式聊天里的风格与关系体验需要持续观察。

## 实现与来源

插件覆写官方 `BasicCompactionEngine.summarize()` 扩展点，采用宿主的 `BlockAssembler` 与 `SummaryResult` 协议。默认编程摘要模板及扩展点可在上游源码中查看。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/src/index.ts)

MIT License。上游实现来源见 [NOTICE](NOTICE)。
