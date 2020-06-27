// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

/* eslint
@typescript-eslint/no-non-null-assertion: "off",
@typescript-eslint/no-explicit-any: "off",
 */

import pb from "../backend/proto";
import {
    interpolateBlues,
    interpolateGreens,
    interpolateReds,
    interpolateOranges,
} from "d3-scale-chromatic";
import "d3-transition";
import { select, mouse } from "d3-selection";
import { scaleLinear, scaleSequential } from "d3-scale";
import { axisBottom, axisLeft } from "d3-axis";
import { showTooltip, hideTooltip } from "./tooltip";
import { GraphBounds } from "./graphs";
import { area, curveBasis } from "d3-shape";
import { min, histogram, sum, max, Bin, cumsum } from "d3-array";

interface Reviews {
    mature: number;
    young: number;
    learn: number;
    relearn: number;
    early: number;
}

export interface GraphData {
    // indexed by day, where day is relative to today
    reviewCount: Map<number, Reviews>;
    reviewTime: Map<number, Reviews>;
}

export enum ReviewRange {
    Month = 0,
    Quarter = 1,
    Year = 2,
    AllTime = 3,
}

const ReviewKind = pb.BackendProto.RevlogEntry.ReviewKind;
type BinType = Bin<Map<number, Reviews[]>, number>;

export function gatherData(data: pb.BackendProto.GraphsOut): GraphData {
    const reviewCount = new Map<number, Reviews>();
    const reviewTime = new Map<number, Reviews>();
    const empty = { mature: 0, young: 0, learn: 0, relearn: 0, early: 0 };

    for (const review of data.revlog as pb.BackendProto.RevlogEntry[]) {
        const day = Math.ceil(
            ((review.id as number) / 1000 - data.nextDayAtSecs) / 86400
        );
        const countEntry =
            reviewCount.get(day) ?? reviewCount.set(day, { ...empty }).get(day)!;
        const timeEntry =
            reviewTime.get(day) ?? reviewTime.set(day, { ...empty }).get(day)!;

        switch (review.reviewKind) {
            case ReviewKind.REVIEW:
                if (review.interval < 21) {
                    countEntry.young += 1;
                    timeEntry.young += review.takenMillis;
                } else {
                    countEntry.mature += 1;
                    timeEntry.mature += review.takenMillis;
                }
                break;
            case ReviewKind.LEARNING:
                countEntry.learn += 1;
                timeEntry.learn += review.takenMillis;
                break;
            case ReviewKind.RELEARNING:
                countEntry.relearn += 1;
                timeEntry.relearn += review.takenMillis;
                break;
            case ReviewKind.EARLY_REVIEW:
                countEntry.early += 1;
                timeEntry.early += review.takenMillis;
                break;
        }
    }

    return { reviewCount, reviewTime };
}

function totalsForBin(bin: BinType): number[] {
    const total = [0, 0, 0, 0, 0];
    for (const entry of bin) {
        total[0] += entry[1].mature;
        total[1] += entry[1].young;
        total[2] += entry[1].learn;
        total[3] += entry[1].relearn;
        total[4] += entry[1].early;
    }

    return total;
}

/// eg idx=0 is mature count, idx=1 is mature+young count, etc
function cumulativeBinValue(bin: BinType, idx: number): number {
    return sum(totalsForBin(bin).slice(0, idx + 1));
}

export function renderReviews(
    svgElem: SVGElement,
    bounds: GraphBounds,
    sourceData: GraphData,
    range: ReviewRange,
    showTime: boolean
): void {
    const xMax = 0;
    let xMin = 0;
    // cap max to selected range
    switch (range) {
        case ReviewRange.Month:
            xMin = -31;
            break;
        case ReviewRange.Quarter:
            xMin = -90;
            break;
        case ReviewRange.Year:
            xMin = -365;
            break;
        case ReviewRange.AllTime:
            xMin = min(sourceData.reviewCount.keys())!;
            break;
    }
    const desiredBars = Math.min(70, Math.abs(xMin!));

    const x = scaleLinear().domain([xMin!, xMax]);
    const sourceMap = showTime ? sourceData.reviewTime : sourceData.reviewCount;
    const bins = histogram()
        .value((m) => {
            return m[0];
        })
        .domain(x.domain() as any)
        .thresholds(x.ticks(desiredBars))(sourceMap.entries() as any);

    const svg = select(svgElem);
    const trans = svg.transition().duration(600) as any;

    x.range([bounds.marginLeft, bounds.width - bounds.marginRight]);
    svg.select<SVGGElement>(".x-ticks")
        .transition(trans)
        .call(axisBottom(x).ticks(6).tickSizeOuter(0));

    // y scale

    const yMax = max(bins, (b: Bin<any, any>) => cumulativeBinValue(b, 4))!;
    const y = scaleLinear()
        .range([bounds.height - bounds.marginBottom, bounds.marginTop])
        .domain([0, yMax]);
    svg.select<SVGGElement>(".y-ticks")
        .transition(trans)
        .call(
            axisLeft(y)
                .ticks(bounds.height / 80)
                .tickSizeOuter(0)
        );

    // x bars

    function barWidth(d: any): number {
        const width = Math.max(0, x(d.x1) - x(d.x0) - 1);
        return width ? width : 0;
    }

    const cappedRange = scaleLinear().range([0.2, 0.5]);
    const shiftedRange = scaleLinear().range([0.4, 0.7]);
    const darkerGreens = scaleSequential((n) =>
        interpolateGreens(shiftedRange(n))
    ).domain(x.domain() as any);
    const lighterGreens = scaleSequential((n) =>
        interpolateGreens(cappedRange(n))
    ).domain(x.domain() as any);
    const blues = scaleSequential((n) => interpolateBlues(cappedRange(n))).domain(
        x.domain() as any
    );
    const reds = scaleSequential((n) => interpolateReds(cappedRange(n))).domain(
        x.domain() as any
    );
    const oranges = scaleSequential((n) => interpolateOranges(cappedRange(n))).domain(
        x.domain() as any
    );

    function tooltipText(d: BinType, cumulative: number): string {
        let buf = `<div>day ${d.x0}-${d.x1}</div>`;
        const totals = totalsForBin(d);
        const lines = [
            [darkerGreens(1), `Mature: ${totals[0]}`],
            [lighterGreens(1), `Young: ${totals[1]}`],
            [blues(1), `New/learn: ${totals[2]}`],
            [reds(1), `Relearn: ${totals[3]}`],
            [oranges(1), `Early: ${totals[4]}`],
            ["grey", `Total: ${cumulative}`],
        ];
        for (const [colour, text] of lines) {
            buf += `<div><span style="color: ${colour}">■</span>${text}</div>`;
        }
        return buf;
    }

    const updateBar = (sel: any, idx: number): any => {
        return sel
            .attr("width", barWidth)
            .transition(trans)
            .attr("x", (d: any) => x(d.x0))
            .attr("y", (d: any) => y(cumulativeBinValue(d, idx))!)
            .attr("height", (d: any) => y(0) - y(cumulativeBinValue(d, idx)))
            .attr("fill", (d: any) => {
                switch (idx) {
                    case 0:
                        return darkerGreens(d.x0);
                    case 1:
                        return lighterGreens(d.x0);
                    case 2:
                        return blues(d.x0);
                    case 3:
                        return reds(d.x0);
                    case 4:
                        return oranges(d.x0);
                }
            });
    };

    for (const barNum of [0, 1, 2, 3, 4]) {
        svg.select(`g.bars${barNum}`)
            .selectAll("rect")
            .data(bins)
            .join(
                (enter) =>
                    enter
                        .append("rect")
                        .attr("rx", 1)
                        .attr("x", (d: any) => x(d.x0))
                        .attr("y", y(0))
                        .attr("height", 0)
                        .call((d) => updateBar(d, barNum)),
                (update) => update.call((d) => updateBar(d, barNum)),
                (remove) =>
                    remove.call((remove) =>
                        remove.transition(trans).attr("height", 0).attr("y", y(0))
                    )
            );
    }

    // cumulative area

    const areaCounts = bins.map((d: any) => cumulativeBinValue(d, 4));
    areaCounts.unshift(0);
    const areaData = cumsum(areaCounts);
    const yAreaScale = y.copy().domain([0, areaData.slice(-1)[0]]);

    if (bins.length) {
        svg.select("path.area")
            .datum(areaData as any)
            .attr(
                "d",
                area()
                    .curve(curveBasis)
                    .x((d, idx) => {
                        if (idx === 0) {
                            return x(bins[0].x0!);
                        } else {
                            return x(bins[idx - 1].x1!);
                        }
                    })
                    .y0(bounds.height - bounds.marginBottom)
                    .y1((d: any) => yAreaScale(d)) as any
            );
    }

    // // hover/tooltip
    svg.select("g.hoverzone")
        .selectAll("rect")
        .data(bins)
        .join("rect")
        .attr("x", (d: any) => x(d.x0))
        .attr("y", () => y(yMax!))
        .attr("width", barWidth)
        .attr("height", () => y(0) - y(yMax!))
        .on("mousemove", function (this: any, d: any, idx) {
            const [x, y] = mouse(document.body);
            showTooltip(tooltipText(d, areaData[idx + 1]), x, y);
        })
        .on("mouseout", hideTooltip);
}
