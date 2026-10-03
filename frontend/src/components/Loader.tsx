const PETALS = [0, 1, 2, 3, 4];

/**
 * 첫 데이터를 기다리는 동안의 표시. 꽃잎 5장이 차례로 피고, 그 뒤로는 72도씩 돌며 오므렸다 편다.
 * 5겹 대칭이라 72도 회전이 끊김 없이 이어진다. 움직임은 styles.css 의 loader 항목에 있고 reduced-motion 이면 멈춘 꽃만 보인다.
 * 다른 화면과 같은 바깥 쉘(.page) 안에 그린다.
 */
export function Loader({ label }: { label: string }) {
  return (
    <div className="page">
      <div className="loader" role="status" aria-live="polite">
        <svg className="loader-mark" width="64" height="64" viewBox="0 0 64 64" aria-hidden>
          <g className="loader-flower">
            {PETALS.map((i) => (
              <g key={i} transform={`rotate(${i * 72} 32 32)`}>
                <ellipse className="loader-petal" cx="32" cy="18" rx="7.5" ry="12.5" style={{ animationDelay: `${i * 70}ms, 750ms` }} />
              </g>
            ))}
            <circle className="loader-core" cx="32" cy="32" r="4.5" />
          </g>
        </svg>
        <span className="loader-label">{label}</span>
      </div>
    </div>
  );
}
