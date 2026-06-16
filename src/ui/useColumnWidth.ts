import { useEffect, useState } from "react";
import { useStdout } from "ink";
import { columnWidth } from "./columnWidth.js";

/**
 * The thin Ink hook over the pure {@link columnWidth} distribution: read the live
 * terminal width and divide it across `columnCount` columns (3 at board level,
 * 7 zoomed). All the math lives in the pure function — this hook is just the
 * terminal-reading seam around it.
 *
 * It reads the width *reactively*: it re-reads on the `resize` event Ink's stdout
 * emits, so resizing the terminal re-distributes the columns live. That live
 * re-distribution is nearly free once the width is read reactively, so it comes
 * for the cost of the subscription rather than as extra machinery.
 */
export function useColumnWidth(columnCount: number): number {
  const { stdout } = useStdout();
  const [terminalWidth, setTerminalWidth] = useState(stdout.columns);

  useEffect(() => {
    const onResize = () => setTerminalWidth(stdout.columns);
    // Catch a resize that happened between the initial read and subscribing.
    onResize();
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return columnWidth(terminalWidth, columnCount);
}
