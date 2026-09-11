import {
  Archive,
  Brain,
  Home,
  BookOpen,
  Briefcase,
  Settings,
  Folder,
  Database,
  FileText,
  Building2,
  KeyRound,
  MailPlus,
  ScrollText,
  type LucideIcon,
} from "lucide-react";
import type { KeyPath } from "./i18n/lang";

/**
 * Issue #19: one static screen definition. Navigation, title keys and the
 * project-scope requirement are all derived from this registry, so adding a
 * screen cannot forget its scope requirement.
 */
export interface ScreenDef {
  id: string;
  titleKey: KeyPath;
  Icon: LucideIcon;
  /** Screens that need an active project to render content. */
  needsProject: boolean;
}

export const screens: ScreenDef[] = [
  { id: "overview", titleKey: "nav.overview", Icon: Home, needsProject: true },
  {
    id: "library",
    titleKey: "nav.library",
    Icon: BookOpen,
    needsProject: true,
  },
  {
    id: "memory",
    titleKey: "nav.memory",
    Icon: Brain,
    needsProject: false,
  },
  { id: "jobs", titleKey: "nav.jobs", Icon: Briefcase, needsProject: true },
  {
    id: "organizations",
    titleKey: "nav.organizations",
    Icon: Building2,
    needsProject: false,
  },
  { id: "roles", titleKey: "nav.roles", Icon: KeyRound, needsProject: false },
  {
    id: "invitations",
    titleKey: "nav.invitations",
    Icon: MailPlus,
    needsProject: false,
  },
  {
    id: "prompts",
    titleKey: "nav.prompts",
    Icon: ScrollText,
    needsProject: false,
  },
  {
    id: "maintenance",
    titleKey: "nav.maintenance",
    Icon: Archive,
    needsProject: true,
  },
  {
    id: "installations",
    titleKey: "nav.installs",
    Icon: Settings,
    needsProject: true,
  },
  {
    id: "projects",
    titleKey: "nav.projects",
    Icon: Folder,
    needsProject: false,
  },
  { id: "models", titleKey: "nav.models", Icon: Database, needsProject: true },
  { id: "logs", titleKey: "nav.logs", Icon: FileText, needsProject: true },
];

export const projectFreeScreens = new Set(
  screens.filter((screen) => !screen.needsProject).map((screen) => screen.id),
);
