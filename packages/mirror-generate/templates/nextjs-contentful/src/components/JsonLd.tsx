/** JSON-LD blobs from CCM meta.structuredData, rendered as in the original (one script per blob). */
export function JsonLd({ data }: { data?: unknown[] }) {
  if (!data?.length) return null;
  return (
    <>
      {data.map((d, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(d).replace(/</g, "\\u003c") }} />
      ))}
    </>
  );
}
