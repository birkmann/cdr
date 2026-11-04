import { fileIconName, folderIconName, iconUrl, useIconStyle, useLightTheme } from "../fileIcons";
import { IFile, IFolder } from "./icons";

/** File or folder icon: colorful (Material Icon Theme) by default, monochrome when chosen in Settings. */
export function FileIcon({
  path,
  dir = false,
  open = false,
  size = 16,
}: {
  path: string;
  dir?: boolean;
  open?: boolean;
  size?: number;
}) {
  const style = useIconStyle();
  const light = useLightTheme();
  if (style === "colorful") {
    const url = iconUrl(dir ? folderIconName(path, open, light) : fileIconName(path, light));
    if (url)
      return <img className="st-file-icon" src={url} width={size} height={size} alt="" draggable={false} />;
  }
  return dir ? <IFolder size={size - 2} open={open} /> : <IFile size={size - 2} />;
}
