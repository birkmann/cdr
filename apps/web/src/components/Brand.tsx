/** CDR's cut-metal C and terminal cursor. Inherits the active theme accent. */
export function CDRMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className="cdr-mark">
      <path d="M24 4H10L2 12V20L10 28H24V22H12L8 18V14L12 10H24ZM18 13H30V19H18Z" fill="currentColor" />
    </svg>
  );
}
