import { useId, type SVGProps } from "react";

// Storefront Code: the Storefront "S" mark (cyan to purple) in place of T3's wordmark, the same SVG
// as the Storefront ERP's BrandMark. Name and props stay upstream's, so no caller changes.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  const gradientId = useId();
  return (
    <svg {...props} viewBox="0 0 105 105" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          y1="0"
          x2="1"
          y2="0"
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(1,0,0,-1,0,0)"
        >
          <stop offset="0" stopColor="#02d7f4" />
          <stop offset="1" stopColor="#9019fe" />
        </linearGradient>
      </defs>
      <g transform="matrix(-104.719,0,0,104.719,104.719,52.421)">
        <path
          fill={`url(#${gradientId})`}
          d="M0.673,-0.501C0.852,-0.501 1.001,-0.354 1,-0.175C0.999,-0.089 0.966,-0.008 0.905,0.052C0.844,0.113 0.763,0.146 0.677,0.146L0.499,0.146C0.495,0.146 0.491,0.146 0.487,0.146L0.323,0.146C0.313,0.146 0.305,0.151 0.301,0.155C0.297,0.159 0.292,0.166 0.292,0.177C0.292,0.195 0.307,0.209 0.324,0.209L0.485,0.209C0.494,0.209 0.501,0.216 0.501,0.225L0.501,0.272C0.501,0.281 0.494,0.288 0.485,0.288L0.323,0.288C0.306,0.288 0.292,0.302 0.292,0.319C0.292,0.336 0.306,0.35 0.323,0.35L0.485,0.35C0.494,0.35 0.501,0.357 0.501,0.366L0.501,0.485C0.501,0.494 0.494,0.501 0.485,0.501L0.327,0.501C0.148,0.501 -0.001,0.354 0,0.175C0.001,0.089 0.034,0.008 0.095,-0.052C0.156,-0.113 0.237,-0.146 0.323,-0.146L0.501,-0.146L0.501,-0.146L0.677,-0.146C0.687,-0.146 0.695,-0.151 0.699,-0.155C0.703,-0.159 0.708,-0.166 0.708,-0.177C0.708,-0.195 0.693,-0.209 0.676,-0.209L0.501,-0.209C0.421,-0.209 0.354,-0.273 0.353,-0.353C0.352,-0.434 0.418,-0.501 0.499,-0.501L0.673,-0.501Z"
        />
      </g>
    </svg>
  );
}
