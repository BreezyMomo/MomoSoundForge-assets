# VCSL 完整乐器采集与发布计划

2026-11-09 用户授权本轮自行制定计划、分批制作并上传 GitHub；达到单库容量限制时创建新的资源仓库。VCSL 中没有对应采样的现有乐器保持现状。下文是执行计划；候选通过、已发布、线上验收必须分别记录，不能把清单存在写成制作完成。

## 权威输入与当前缺口

- 可执行清单：[sources/vcsl-instruments.json](../sources/vcsl-instruments.json)。它只属于资源仓库，不能复制到应用仓库。
- 来源：[sgossner/VCSL](https://github.com/sgossner/VCSL)，`sfz` 分支固定提交 `dfcf4a4918771eee884b96ad4493de82ef84daf6`。许可为 CC0-1.0，证据为同提交的 README；原件 Git blob、SFZ 文本 SHA-256 和每份音频原件哈希随采集证据保存。
- 共核对 183 份 SFZ，合并技法图和重复映射后为 102 组完整乐器。其中 Kawai 大钢琴、Concert Harp、Tenor Saxophone 已有已发布定义；本轮新增 99 组，检查并保留这三个完整定义，清理对应旧单音目录条目。
- 每组优先选作者 Keyswitch 图，它包含同组独立技法图的全部采样；无 Keyswitch 时选主 SFZ。现代 Kawai 替代同组 Legacy 图，不作为第二份重复钢琴导入。其他有独立录音的早期鼓、铃鼓等保留为可辨认的乐器版本。
- 选中映射共引用 4,059 份 WAV，原始文件约 5,597.5 MiB。这是原始 WAV 容量，不能当作发布体积或 PCM 解码预算。
- Psaltery 的 SFZ 在固定快照中引用了错误目录，实体录音位于 `Chordophones/Zithers/Harpsichord, Italian/Psaltery, Bowed and Plucked/`。清单记录同一快照内的路径修正，不混用 `master` 的录音。较新的 `master` 补充 LICENSE 并移动了这个目录，但不提供这些 SFZ。

## 执行批次

1. **打击乐**：先完成钟琴、马林巴、木琴、定音鼓及现有单音对应的大鼓、小军鼓、钹、三角铁和铃鼓，再完成其余鼓、铃、镲、音管、颤音琴、非洲拇指琴及打击效果。该批共 70 组。
2. **吹奏与拨弦**：整理四种音域竖笛、两款陶笛、三款口琴、Saxello、迪吉里杜管及哨类；整理民谣竖琴、Strumstick、越南筝和诗琴。连同已有竖琴、次中音萨克斯，该批共 20 组。
3. **键盘与合成音色**：风琴、五款羽管键琴、TX81Z、Steinway B 与 Knight／Yamaha 立式钢琴；连同已有 Kawai，共 12 组。大型钢琴单独核查资源预算。

分类继续按乐器用途使用 `percussion`、`woodwinds`、`strings`、`keys`，不把仓库名或来源当作分类。完整资源的中英文名称由清单和资源包自己携带；演奏法采用标准语义值或资源自身双语显示元数据，主工程不保存 VCSL 名称补丁表。

## 分库与预算

先以清单中的 `suggestedLibrary` 组织候选：打击旋律、其他打击乐、定音鼓、吹奏、拨弦、羽管键琴、风琴与合成音色，以及大型钢琴。它们是容量规划提示，不是已经创建或发布的仓库记录。最终按候选目录的真实字节数决定边界，已有三个完整 VCSL 乐器保留原订阅，避免重复发布。

- 单库规划上限 **850 MiB**，留出验证产物和后续更新余量；Pages 站点严格小于 **1 GiB**。达到规划上限时拆为新的 `BreezyMomo/MomoSoundForge-assets-vcsl-*` 仓库和稳定 `libraryId`。
- 每库独立带齐自身全部定义和音频依赖。不能把一个乐器的依赖拆给另一个必须同时订阅的库；相同音频在各库可独立托管，应用仍按 PCM 内容 ID 去重。
- 单份可分享资源仍受 **768 MiB 压缩包、1.5 GiB 完整 PCM、2,048 份录音、512 个区域**等应用预算约束。增加仓库不能解决单个定义超预算；不提高限制、不截取预览长度、不删未演奏的琴键来绕过。
- 大型钢琴先计算实际 PCM 和分享包体积。若作者的不同踏板音色无法在一个定义内满足预算，先记录明确方案：保留可独立完整使用的真实音色变体，或采用有记录、可复现且通过质量检查的采样率转换。不能把待处理钢琴标成已经完整发布。
- 音频、内嵌音频包和生成目录只进入固定 Releases／Actions／Pages，不能进入任何仓库 Git 历史。源码、映射、哈希、授权和执行证据由资源仓库维护。

## 替换目录条目

清单 `replaceRecordingEntryIds` 精确列出 238 个候选旧条目：222 个 Kawai 单音，以及竖琴、定音鼓、钟琴、马林巴、木琴、大鼓、小军鼓、碰钹、三角铁和铃鼓的 16 个代表录音。只有对应完整资源验收并发布后，才从活动目录移除这些条目。

移除只改变目录展示，不物理删除旧目录引用过的不可变音频／图文件，不破坏示例、依赖或已经打开的工程。旧演示仍保留其完整依赖，不因换目录自动换音源。

VCSL 没有对应来源的长笛、小提琴组、大提琴组、独奏小提琴、圆号、小号、单簧管、长号以及中提琴、低音提琴、短笛、双簧管、巴松、大号等现有资源及单音条目保持原状。游戏音效、自然环境与其他非乐器录音不属于此次删除范围。

## 每批制作与验收

1. 下载固定提交的选中 SFZ 与其完整 WAV 闭包；逐份核对 Git blob／原件 SHA-256，保留许可和获取日期。原件不能用试听 MP3 替代。
2. 依据作者图转换根音、键域、力度、技法、轮替、增益、调音、offset、包络和松键。保持完整录音，不能逐音归一化或发明循环。引擎暂不支持的交叉淡化或控制器语义必须保留转换记录，说明实际适配方式；不能悄悄丢弃区域。
3. 使用固定应用提交的 `sealResource`、严格 `openResourceGraph` 生成完整 `kind: instrument` 定义。每库检查图根、条目身份、全部对象引用、PCM 内容 ID、传输 SHA-256、解压预算与依赖闭包。
4. 对所有新增完整乐器扩展验证范围，调用真实 `scoreIssues`／`projectScoreIssues` 检查各技法 MIDI 与力度边界、轮替、短音和接近录音持续长度的长音。按照作者真正支持的音高集合穷举力度；有意稀疏的鼓键不能伪称连续旋律音域。
5. 原生渲染检查静音、异常峰值、有效录音长度与松键尾音，生成试听并记录实际主观听审范围。保存、重开、WAV 导出一致；分享后断开远端仍能添加此前未演奏的已有音高。
6. 候选验证成功后，上传新的固定 Release 附件，重新下载核对大小与 SHA-256。运行 `publish=false`，检查验证报告；再以同一提交、同一附件运行 `publish=true`。
7. 线上核验目录、CORS、严格加载、空缓存依赖恢复与真实浏览器试听，再更新对应的旧单音目录。新库可用后，应用只更新默认订阅 URL；不放回采样、资源目录或映射清单。
8. 每次记录库 ID、URL、Git 提交、Release、附件哈希、候选及部署 CI、目录哈希、验收范围和剩余限制。提交前精确检查暂存区，其他聊天的工程／技能编辑不纳入本批提交。

清单再生成入口（证据文件由同一固定来源生成）：

```sh
node tools/vcsl-inventory.mjs --evidence-prefix /path/to/vcsl-audit-20261109 --output sources/vcsl-instruments.json
```

本计划的“制作”和“发布”状态以每批真实验证与部署记录为准；本文件创建时尚未代表新增 99 组已经上线。

## 组装契约与当前自动化进展

- `sources/vcsl-articulation-names.json` 是资源包构建输入，不是主工程的名称补丁表。它使用 `momo.vcsl-articulation-names/v1`：`names` 提供所有映射共用的演奏法中英文名称，`instruments` 只在同一 slug 在特定乐器中语义不同的情况下覆盖。演奏法 ID 仍是稳定的机器值，语言切换只改变显示文本。
- `tools/assemble-vcsl.mjs --instruments <validated-instruments> --output <sites>` 读取每个已验证乐器目录的 `entry.json`、`audio.json`、`report.json` 和 `remote/` 闭包。它按 `suggestedLibrary` 分组，以真实文件字节在 850 MiB 规划上限处分库；单个乐器不会被拆分，超出时使用稳定的 `-2`、`-3` 后缀。每个站点写入独立 `index.json`、`validation-scope.json`、`provenance/` 和 `snapshot-manifest.json`，并对音频 ID 元数据冲突、路径穿越、符号链接和 1 GiB 硬上限拒绝。
- `snapshot-manifest.json` 列出站点除自身以外的每个普通文件及传输字节 SHA-256；音频和图通过内容哈希文件名在站点内去重，允许同盘 hardlink，禁止 symlink。每站点 `provenance/VCSL-license.json` 固定来源提交、CC0 许可和证据链接，随快照一起发布。资源仓库发布工具随后从该快照恢复并再次核验，发布附件固定版本，不能覆盖既有附件或使用 `latest`。
- `assembly-report.json` 除每个站点的大小、条目和音频计数外，还记录每个清单 `manifestId` 首次分配到的稳定 `libraryId`、目录和 entry ID，作为分库边界与后续发布记录的权威映射。
- 已完成演奏法字典、压缩音频解码（MP3/OGG/OGA/Opus）和组装器代码。固定 VCSL 快照已生成 100 个完整变体（含既有 Concert Harp、Tenor Saxophone、Kawai 复用），其中 98 个首轮 WAV 转换完成，Gong 2 与 Tubular Bells 3 经可复现压缩解码后补齐；两者保留原始 Git blob 来源记录。组装器按真实大小生成 11 个候选库（施坦威延音踏板独立分库），全部通过 `validate-library` 的图、依赖、音域和全力度边界检查。候选／部署运行号、Release 附件哈希和 Pages 目录哈希在发布完成后追加记录。

## 2026-11-09 schema3 发布记录

所有库使用 Git 提交 `94b151eb065e614307fa2ec6f9e8138d2266f603`（工具仓库 `main`）和固定 Release tag `2026.11.09-vcsl-complete-schema3`。候选运行先验证 `library-clean.zip`（ZIP 内路径无 `./` 前缀），部署运行随后使用同一附件；原始 `library.zip` 附件保留但不用于线上部署。11 个 Pages 目录均返回 200、CORS 为 `*`，并通过空缓存候选与部署验证：

| libraryId | Release / ZIP SHA-256 | candidate → deploy | Pages index SHA-256 |
|---|---|---|---|
| `vcsl-harpsichords` | `48deb8c0351546ba5076d73a0479f4d99048dcba80f3561cd4747c44b369fba` | `42638510821 → 42638942107` | `a4c9a7f05ca406fa624c9cda3649ed5d6b0c0c7284a6c40b9bdea9f7ba2c5a5b` |
| `vcsl-keyboards` | `f9d661cac88698db3ba82486f9445ce00102b0fc433316810f3949c8e2f25228` | `42638117026 → 42638947599` | `9fbc0ee064a5f6e7ab71043032889225af5ee8ec14cde3824e2d99cc00d3fc14` |
| `vcsl-mallets` | `4e2ab6cd8391a7839629a3354921d0dd5bb5aa20dc1a13d5d46ab29e1f97b540` | `42638121276 → 42638952020` | `8a0f63ab061a78f2996159676bcca78f7d0afaa74fb5021c2b40963ecc734e0b` |
| `vcsl-percussion` | `095376a4d7c9ed48b917c48901fa75e1197c092a4729cc5f74f6b6a8c746f0dc` | `42638125601 → 42638956157` | `18c9191854e080ffe5880fd2c0b1e28f5e1d46af51064ca18dff7677259a6f0e` |
| `vcsl-piano-knight` | `183b0bd92fb92187dc29cc22d9b1167ec5fb35c48712691c2f2275cf377937ba` | `42638129366 → 42638959826` | `7ad452ab876519c31007129450be6df127a7914e8ab3dac480c630436907c8fa` |
| `vcsl-piano-steinway` | `239b5d8a084f861eb84556cade3076773e4477354645688e0e0ace99107e4bba` | `42638132639 → 42638964214` | `a8d84393e6d39e84811322203689682f8fe6d9d88b76e9d8581c31236c834f4d` |
| `vcsl-piano-steinway-2` | `4966ccaf518394d33ceee52c6efe085e9cb84ecc98b32d3325bdd8fb0054a2a9` | `42638135843 → 42641069190` | `a5c33b46fb3a7a114006b8c80a63a0dee7c52cb01a97dcbe72533a1d9caf7b96` |
| `vcsl-piano-yamaha` | `4c7688dadf0cd29bd059cd100df0901098a686de1d87086f9e55f39b6a0d84b0` | `42638140065 → 42638971609` | `10734ca1d52ef4211ab740ee7a6f0b2e734738bafa08b66b4e5999aede5e2d35` |
| `vcsl-plucked` | `46a98357023ec20f94038bf6118e2f6065a3c3d53b7d1b6839bce1288e2583fa` | `42638144575 → 42638976116` | `519ad67a8704f35b152a1826d0c4d1c84e08f6c89eda3edbddb0af4d81d31a02` |
| `vcsl-timpani` | `f40912ef39a7860584ca0b44071164a80ef979957781cfa07a756c61fbb7ffce` | `42638148365 → 42638979231` | `68a91889cd547b2eee73c6433944ecd58ee7a99276807fbacdea87371f21ef61` |
| `vcsl-winds` | `de0086cf2347fa7e390cfe708e7d7b4f1c7f60545ce9e37e68d2dbb307cefe5c` | `42638152064 → 42638983637` | `9c0d0318a388c3246f91598e8bcf9b145e1daafa3b2dedd15e8a9f6882619fd5` |

其中 `Gong 2` 与 `Tubular Bells 3` 的原始 VCSL 文件是 MP3/OGG，已通过锁定的 `audio-decode` 一次性解码为规范 Float32 PCM，并在来源报告中保留原始 blob；不支持的压缩格式不再是遗留缺口。
