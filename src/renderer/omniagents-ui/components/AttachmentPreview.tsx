import { useCallback } from 'react';

/** The mounted preview owns its blob URL; rerenders must not allocate more. */
export function AttachmentPreview({ file }: { file: File }) {
  const attach = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image) {
        return;
      }
      const url = URL.createObjectURL(file);
      image.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [file]
  );
  return <img ref={attach} alt="" className="size-20 rounded-lg object-cover border border-border" />;
}
