# post_fix.py —— pptxgenjs 产物的 OOXML 修复后处理
#
# 存在的意义：
#   pptxgenjs 生成的 slide XML 会在同一个段落 <a:p> 里输出多个 <a:pPr>（段落属性）。
#   OOXML 规范规定每个 <a:p> 最多只能有一个 <a:pPr>，且必须是第一个子元素；
#   PowerPoint 按严格 schema 校验，遇到重复就判定文件损坏，提示"需要修复"甚至直接拒绝打开。
#   所以构建流水线是：node build_ppt.mjs 生成 .tmp/out_new.pptx → 本脚本修复 → 覆盖成品。
#
# 用法：python post_fix.py <输入.pptx> <输出.pptx>

import re, sys, zipfile

src, dst = sys.argv[1], sys.argv[2]                      # 输入 / 输出路径来自命令行参数

zin  = zipfile.ZipFile(src)                              # 原包：只读打开（pptx 本质是 zip）
zout = zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED)   # 新包：逐条目重写后输出

# [Content_Types].xml 排到 zip 首位（部分 OPC 阅读器按首条目定位内容类型表，防御性排序）
names = [n for n in zin.namelist() if not n.endswith('/')]   # 跳过目录占位条目
names.sort(key=lambda n: (n != '[Content_Types].xml',))

# 匹配一个完整的 <a:pPr .../>（自闭合）或 <a:pPr ...>...</a:pPr>
pat  = re.compile(r'<a:pPr\b[^>]*(?:/>|>.*?</a:pPr>)', re.DOTALL)
# 匹配一个完整段落 <a:p>...</a:p>
para = re.compile(r'<a:p>.*?</a:p>', re.DOTALL)

def fix_para(m):
    """处理单个 <a:p> 段落：保留第一个 <a:pPr>，删除其后重复出现的。"""
    body, seen = m.group(0), [0]

    def repl(pm):
        seen[0] += 1
        return pm.group(0) if seen[0] == 1 else ''       # 第 1 个保留，其余替换为空即删除

    return pat.sub(repl, body)

for n in names:
    data = zin.read(n)
    if re.match(r'ppt/slides/slide\d+\.xml$', n):        # 只有各页 slide XML 需要修复
        xml  = data.decode('utf-8')
        xml  = para.sub(fix_para, xml)                   # 逐段落去重 <a:pPr>
        data = xml.encode('utf-8')
    zout.writestr(n, data)                               # 其余条目（图片、字体等）原样复制

zout.close()
zin.close()
print('post-fixed ->', dst)
