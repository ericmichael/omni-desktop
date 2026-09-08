import type { Attachment } from '@/shared/chat-types';

export async function encodeMessage(text: string, files?: File[]) {
  let content: any | undefined = undefined;
  let attachments: Attachment[] = [];
  if (files && files.length > 0) {
    const parts: any[] = [];
    if (text.trim().length > 0) {
      parts.push({ type: 'input_text', text });
    }
    const processed = await Promise.all(
      files.map(async (f) => {
        if (f.type && f.type.startsWith('image/')) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Failed to read image'));
            reader.onabort = () => reject(new Error(`Reading attachment "${f.name}" was cancelled. Please retry.`));
            reader.readAsDataURL(f);
          });
          return {
            filePart: { type: 'input_image', image_url: dataUrl, detail: 'auto' },
            attachment: { type: 'image' as const, url: dataUrl, filename: f.name, mime: f.type, size: f.size },
          };
        } else {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              try {
                const buf = reader.result as ArrayBuffer;
                const bytes = new Uint8Array(buf);
                let binary = '';
                for (let i = 0; i < bytes.length; i++) {
                  binary += String.fromCharCode(bytes[i]!);
                }
                resolve(btoa(binary));
              } catch {
                reject(new Error('Failed to encode file'));
              }
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.onabort = () => reject(new Error(`Reading attachment "${f.name}" was cancelled. Please retry.`));
            reader.readAsArrayBuffer(f);
          });
          const param: any = { type: 'input_file', file_data: base64 };
          if (f.name) {
            param.filename = f.name;
          }
          return {
            filePart: param,
            attachment: { type: 'file' as const, filename: f.name, mime: f.type, size: f.size },
          };
        }
      })
    );
    parts.push(...processed.map((p) => p.filePart));
    attachments = processed.map((p) => p.attachment);
    content = parts;
  }

  return { content, attachments };
}
