interface Props {
  top: number;
  left: number;
  flipped: boolean;
  onClick: () => void;
  label?: string;
}

export function SelectionCopyButton({
  top,
  left,
  flipped,
  onClick,
  label = "复制到辅助栏",
}: Props) {
  return (
    <button
      type="button"
      data-selection-action
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{
        position: "fixed",
        top,
        left,
        transform: flipped
          ? "translate(-50%, 0%)"
          : "translate(-50%, -100%)",
        zIndex: 60,
      }}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-blue-600 text-white shadow-lg hover:bg-blue-500 transition"
    >
      <svg
        viewBox="0 0 16 16"
        width="13"
        height="13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <rect x="4.5" y="4.5" width="9" height="9" rx="1.5" />
        <path d="M2.5 11.5V3a1.5 1.5 0 0 1 1.5-1.5h7.5" />
      </svg>
      {label}
    </button>
  );
}
