import { useState, useRef, useCallback, useEffect } from "react";
import { Upload, X, Image, Loader2, Camera, ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface PhotoUploadProps {
  onUpload: (url: string) => void;
  onRemove?: () => void;
  onError?: (error: string) => void;
  existingUrl?: string;
  className?: string;
  disabled?: boolean;
}

export function PhotoUpload({ onUpload, onRemove, onError, existingUrl, className, disabled }: PhotoUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(existingUrl ?? null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPreview(existingUrl ?? null);
  }, [existingUrl]);

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      onError?.("Please select an image file");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      onError?.("File size must be less than 10MB");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      setPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || "Upload failed");
      }

      const data = await response.json();
      if (!data.url) {
        throw new Error("No URL returned from server");
      }
      onUpload(data.url);
      setPreview(data.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to upload file";
      onError?.(message);
      setPreview(existingUrl ?? null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } finally {
      setIsUploading(false);
    }
  }, [onUpload, onError, existingUrl]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    if (disabled) return;

    const file = e.dataTransfer.files[0];
    if (file) {
      handleFile(file);
    }
  }, [disabled, handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) {
      setIsDragging(true);
    }
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleClick = () => {
    if (!disabled && fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFile(file);
    }
  };

  const clearPreview = () => {
    setPreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    onRemove?.();
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={handleClick}
        className={cn(
          "relative border-2 border-dashed rounded-lg p-6 transition-colors cursor-pointer",
          "flex flex-col items-center justify-center gap-2 min-h-[150px]",
          isDragging && "border-primary bg-primary/5",
          !isDragging && "border-muted-foreground/25 hover:border-muted-foreground/50",
          disabled && "opacity-50 cursor-not-allowed",
          preview && "p-2"
        )}
        data-testid="photo-upload-dropzone"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
          disabled={disabled}
          data-testid="input-file-upload"
        />

        {isUploading ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Uploading...</span>
          </div>
        ) : preview ? (
          <div className="relative w-full">
            <img
              src={preview}
              alt="Preview"
              className="w-full h-auto max-h-[200px] object-contain rounded"
              data-testid="img-upload-preview"
            />
            <Button
              type="button"
              size="icon"
              variant="destructive"
              className="absolute top-1 right-1 h-6 w-6"
              onClick={(e) => {
                e.stopPropagation();
                clearPreview();
              }}
              data-testid="button-clear-preview"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <div className="rounded-full bg-muted p-3">
                <Camera className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="rounded-full bg-muted p-3">
                <ImageIcon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="rounded-full bg-muted p-3">
                <Upload className="h-5 w-5 text-muted-foreground" />
              </div>
            </div>
            <div className="text-center mt-2">
              <p className="text-sm font-medium">
                Take a photo or choose from library
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Tap to open camera, photos, or files
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-2">
              <Image className="h-4 w-4" />
              <span>JPG, PNG, GIF, WebP (max 10MB)</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
