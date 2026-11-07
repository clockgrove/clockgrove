/** The monogram stand-in: the uppercase first letter of the label's last dot-separated segment. */
export function portraitMonogram(label: string): string {
  const segment = label.split(".").pop() ?? "";
  return (segment || label).charAt(0).toUpperCase();
}

/**
 * An actor's round portrait, named by the actor's label. It draws the portrait asset that the
 * actor's presentation binding references when there is one, and the monogram otherwise. Every
 * place that shows an actor's portrait uses this component (feed rows now, the rail later).
 */
export function Portrait({
  label,
  portrait,
  className,
}: {
  readonly label: string;
  /** The URL of the reviewed portrait asset from the actor's presentation binding, if any. */
  readonly portrait?: string | undefined;
  readonly className?: string;
}) {
  return (
    <span
      className={className ? `rw-portrait ${className}` : "rw-portrait"}
      data-icon="portrait"
      data-portrait={portrait === undefined ? "monogram" : "asset"}
      role="img"
      aria-label={label}
    >
      {portrait === undefined ? (
        <span aria-hidden="true">{portraitMonogram(label)}</span>
      ) : (
        <img src={portrait} alt="" />
      )}
    </span>
  );
}
