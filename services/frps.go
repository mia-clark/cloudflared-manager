package services

import (
	"context"

	v1 "github.com/fatedier/frp/pkg/config/v1"
	"github.com/fatedier/frp/pkg/util/log"
	frpserver "github.com/fatedier/frp/server"
)

// FrpServerService 内嵌单个 frps 服务端实例。
// 生命周期：Run(ctx) 阻塞运行、Close() 优雅关闭。
//
// 注意（v0.69.1 源码核验）：
//   - server.NewService(cfg) (*Service, error)
//   - (*Service).Run(ctx) 无返回值，阻塞至 ctx.Done
//   - (*Service).Close() error
//
// webServer 必须在传入前由调用方（worker）改写为非零 loopback 端口——
// Port==0 时 frps 完全不起 webServer（无 mem / 无 /api/clients）。
type FrpServerService struct {
	svr *frpserver.Service
}

// NewFrpServerService 用已 Complete 的 ServerConfig 构造 frps 服务。
func NewFrpServerService(cfg *v1.ServerConfig) (*FrpServerService, error) {
	svr, err := frpserver.NewService(cfg)
	if err != nil {
		return nil, err
	}
	return &FrpServerService{svr: svr}, nil
}

// Run 阻塞运行 frps，直到 ctx 取消。
func (s *FrpServerService) Run(ctx context.Context) {
	log.Infof("start frps service")
	defer log.Infof("frps service stopped")
	s.svr.Run(ctx)
}

// Close 关闭所有监听并停止服务。
func (s *FrpServerService) Close() error {
	return s.svr.Close()
}
