// BrandMark —— Cloudflared 隧道管理器 的线稿品牌标志（云 + 隧道流向箭头）。
// 描边用 currentColor / color 入参，便于放在不同底色的品牌容器里。
const BrandMark: React.FC<{ size?: number; color?: string; strokeWidth?: number }> = ({
  size = 24,
  color = 'currentColor',
  strokeWidth = 4,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 64 64"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    role="img"
  >
    <path d="M20 42h22a8 8 0 0 0 1-16 12 12 0 0 0-23-3 9 9 0 0 0 0 19Z" />
    <path d="M26 33h12m0 0-4.2-4.2m4.2 4.2-4.2 4.2" />
  </svg>
);

export default BrandMark;
