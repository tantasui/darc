"use client";

/**
 * The product shell: a persistent left rail on desktop, a bottom bar on phones, and an
 * account block that shows who is signed in. Every screen renders inside this, so the
 * product has a frame rather than being a set of standalone pages.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Wordmark, Mark } from "./brand";
import { ActivityIcon, AgentsIcon, CardsIcon, HomeIcon, SettingsIcon, VerifyIcon } from "./icons";
import { useOwner } from "@/lib/owner-context";
import s from "./shell.module.css";

const NAV = [
  { href: "/", label: "Home", icon: HomeIcon },
  { href: "/cards", label: "Cards", icon: CardsIcon },
  { href: "/activity", label: "Activity", icon: ActivityIcon },
  { href: "/agents", label: "Agents", icon: AgentsIcon },
] as const;

const PUBLIC_NAV = [
  { href: "/verify", label: "Verify", icon: VerifyIcon },
  { href: "/settings", label: "Account", icon: SettingsIcon },
] as const;

/** Phones get the five most-used destinations; Account lives on the Home screen there. */
const MOBILE_NAV = [...NAV, PUBLIC_NAV[0]];

export function Shell({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const { owner, signOut } = useOwner();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <div className={s.layout}>
      <aside className={s.rail}>
        <Link href="/" className={`${s.brand} ${s.inherit}`}>
          <Wordmark />
        </Link>

        <nav className={s.nav}>
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={`${s.navItem} ${isActive(href) ? s.navActive : ""}`}>
              <span className={s.navIcon}>
                <Icon />
              </span>
              {label}
            </Link>
          ))}

          <div className={s.navSection}>Public</div>
          {PUBLIC_NAV.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={`${s.navItem} ${isActive(href) ? s.navActive : ""}`}>
              <span className={s.navIcon}>
                <Icon />
              </span>
              {label}
            </Link>
          ))}
        </nav>

        <div className={s.account}>
          {owner ? (
            <>
              <div className={s.accountRow}>
                <span className={s.avatar} />
                <div className={s.min0}>
                  <div className={s.accountName}>
                    {owner.slice(0, 6)}…{owner.slice(-4)}
                  </div>
                  <div className={s.accountMeta}>Passkey account</div>
                </div>
              </div>
              <button className={s.signOut} onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <div className={s.accountMeta}>Not signed in</div>
          )}
        </div>
      </aside>

      <div className={s.min0}>
        <div className={s.mobileTop}>
          <Link href="/" className={s.inherit}>
            <Wordmark size={19} />
          </Link>
          <Link href="/settings" className={s.accountMeta}>
            {owner ? `${owner.slice(0, 6)}…${owner.slice(-4)}` : "Sign in"}
          </Link>
        </div>

        <main className={s.main}>
          <header className={s.header}>
            <div className={s.headerRow}>
              <div>
                <h1 className={s.title}>{title}</h1>
                {subtitle && <p className={s.subtitle}>{subtitle}</p>}
              </div>
              {action}
            </div>
          </header>
          {children}
        </main>

        <nav className={s.mobileBar}>
          {MOBILE_NAV.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={`${s.mobileItem} ${isActive(href) ? s.mobileActive : ""}`}>
              <Icon size={19} />
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}

export { Mark };
