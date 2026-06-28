import type { ReactNode } from "react";

export const metadata = {
  title: "Homodeus Chat",
  description: "A room where our agents talk.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#fbfaf8",
          color: "#1a1a1a",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        {children}
      </body>
    </html>
  );
}
