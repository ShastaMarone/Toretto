import { useState, type DragEvent } from 'react';

/** Drag a tier's header onto another's to move it: what GroupRows needs to take part. */
export interface GroupDrag {
  dragging: boolean;
  /** Something is being dragged over this header. */
  over: boolean;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
  /** The same change without dragging (touch screens, or browsers where dragging is fiddly). */
  moveUp?: () => void;
  moveDown?: () => void;
}

/**
 * Lets tier headers be dragged into a new order. `keys` is the order on screen
 * ('none', the people without a tier, always stays last); `onReorder` gets the
 * new order. Returns each group's drag props, or nothing when reordering is off.
 */
export function useGroupReorder(keys: string[], onReorder?: (keys: string[]) => void) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const reset = () => {
    setDragging(null);
    setOver(null);
  };
  return (key: string): GroupDrag | undefined => {
    if (!onReorder || key === 'none') return undefined;
    const tiers = keys.filter((k) => k !== 'none');
    const at = tiers.indexOf(key);
    const swapWith = (other: number) => () => {
      const next = [...tiers];
      [next[at], next[other]] = [next[other]!, next[at]!];
      onReorder(keys.includes('none') ? [...next, 'none'] : next);
    };
    return {
      moveUp: at > 0 ? swapWith(at - 1) : undefined,
      moveDown: at < tiers.length - 1 ? swapWith(at + 1) : undefined,
      dragging: dragging === key,
      over: over === key && dragging !== key,
      onDragStart: (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', key);
        setDragging(key);
      },
      onDragEnd: reset,
      onDragOver: (e) => {
        if (!dragging || dragging === key) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(key);
      },
      onDrop: (e) => {
        e.preventDefault();
        if (dragging && dragging !== key) {
          const next = keys.filter((k) => k !== dragging);
          // Moving down lands after the one it's dropped on; moving up, before it.
          const at = next.indexOf(key) + (keys.indexOf(dragging) < keys.indexOf(key) ? 1 : 0);
          next.splice(at, 0, dragging);
          onReorder(next);
        }
        reset();
      },
    };
  };
}
