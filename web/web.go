package web

import (
	"embed"
	"io/fs"
)

//go:embed dist
var embedFS embed.FS

// GetFS 返回一个针对 dist 子目录的文件系统只读包装。
// 这可以让外部调用时直接访问到 index.html，而无需在路径中带上 "dist/" 前缀。
func GetFS() fs.FS {
	subFS, err := fs.Sub(embedFS, "dist")
	if err != nil {
		// 这里由于 dist 目录我们在编译前已经确保存在占位文件，
		// 所以 sub 理论上绝不会出错。
		panic(err)
	}
	return subFS
}
