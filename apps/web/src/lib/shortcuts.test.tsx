import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/render";
import { ShortcutDialog } from "../components/ShortcutDialog";
import { useGlobalShortcuts, useListKeyboard } from "./shortcuts";

interface Item {
  id: string;
}
const ITEMS: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }];

function List(props: {
  onOpen: (i: Item) => void;
  keys?: Record<string, (i: Item) => void>;
  items?: Item[];
}) {
  const { focusedIndex, getRowProps } = useListKeyboard(props.items ?? ITEMS, {
    onOpen: props.onOpen,
    keys: props.keys,
  });
  return (
    <div>
      <input aria-label="Search" />
      <p data-testid="focused">{focusedIndex}</p>
      <ul>
        {(props.items ?? ITEMS).map((item, i) => (
          <li key={item.id} {...getRowProps(i)}>
            row {item.id}
          </li>
        ))}
      </ul>
    </div>
  );
}

describe("useListKeyboard", () => {
  it("j/k move focus, Enter opens and s/d/a/o call their handlers; typing in an input doesn't trigger them", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const handlers = { s: vi.fn(), d: vi.fn(), a: vi.fn(), o: vi.fn() };
    renderWithProviders(<List onOpen={onOpen} keys={handlers} />);
    expect(screen.getByTestId("focused")).toHaveTextContent("-1");

    await user.keyboard("j");
    expect(screen.getByTestId("focused")).toHaveTextContent("0");
    await user.keyboard("jj");
    expect(screen.getByTestId("focused")).toHaveTextContent("2");
    await user.keyboard("j");
    expect(screen.getByTestId("focused")).toHaveTextContent("2");
    await user.keyboard("k");
    expect(screen.getByTestId("focused")).toHaveTextContent("1");
    expect(screen.getByText("row b")).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith({ id: "b" });
    await user.keyboard("s");
    await user.keyboard("d");
    await user.keyboard("a");
    await user.keyboard("o");
    expect(handlers.s).toHaveBeenCalledWith({ id: "b" });
    expect(handlers.d).toHaveBeenCalledWith({ id: "b" });
    expect(handlers.a).toHaveBeenCalledWith({ id: "b" });
    expect(handlers.o).toHaveBeenCalledWith({ id: "b" });

    // typing in the input triggers nothing and does not move focus
    await user.click(screen.getByLabelText("Search"));
    await user.keyboard("jsdao{Enter}");
    expect(screen.getByLabelText("Search")).toHaveValue("jsdao");
    expect(screen.getByTestId("focused")).toHaveTextContent("1");
    expect(handlers.s).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("arrow keys move focus too, and a shortcut with a modifier is ignored", async () => {
    const user = userEvent.setup();
    const s = vi.fn();
    renderWithProviders(<List onOpen={vi.fn()} keys={{ s }} />);
    // arrows only act from inside a row, so the page can still scroll with them
    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("focused")).toHaveTextContent("-1");
    await user.keyboard("j{ArrowDown}");
    expect(screen.getByTestId("focused")).toHaveTextContent("1");
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByTestId("focused")).toHaveTextContent("0");
    await user.keyboard("{Control>}s{/Control}");
    expect(s).not.toHaveBeenCalled();
  });

  it("keeps the focused index inside the list when rows are removed", async () => {
    const user = userEvent.setup();
    function Shrinking() {
      const [items, setItems] = useState(ITEMS);
      return (
        <>
          <button type="button" onClick={() => setItems(ITEMS.slice(0, 1))}>
            Shrink
          </button>
          <List onOpen={vi.fn()} items={items} />
        </>
      );
    }
    renderWithProviders(<Shrinking />);
    await user.keyboard("jjj");
    expect(screen.getByTestId("focused")).toHaveTextContent("2");
    await user.click(screen.getByRole("button", { name: "Shrink" }));
    expect(screen.getByTestId("focused")).toHaveTextContent("0");
  });

  it("clicking a row focuses it, and Enter on a button inside a row does not open the row", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    function WithButton() {
      const { getRowProps } = useListKeyboard(ITEMS, { onOpen });
      return (
        <ul>
          <li {...getRowProps(0)}>
            <button type="button">Inner</button>
          </li>
        </ul>
      );
    }
    renderWithProviders(<WithButton />);
    screen.getByRole("button", { name: "Inner" }).focus();
    await user.keyboard("{Enter}");
    expect(onOpen).not.toHaveBeenCalled();
  });
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
function Shortcuts() {
  useGlobalShortcuts();
  return (
    <>
      <input aria-label="Notes" />
      <div contentEditable suppressContentEditableWarning aria-label="Rich">
        edit
      </div>
      <select aria-label="Pick">
        <option>one</option>
      </select>
      <textarea aria-label="Long" />
      <Where />
      <ShortcutDialog />
    </>
  );
}

describe("useGlobalShortcuts", () => {
  it("g then l navigates to /leads; ? opens the shortcut dialog", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Shortcuts />, { route: "/today" });
    await user.keyboard("gl");
    expect(screen.getByTestId("where")).toHaveTextContent("/leads");
    await user.keyboard("gt");
    expect(screen.getByTestId("where")).toHaveTextContent("/today");
    await user.keyboard("ga");
    expect(screen.getByTestId("where")).toHaveTextContent("/applications");
    await user.keyboard("gi");
    expect(screen.getByTestId("where")).toHaveTextContent("/interviews");
    await user.keyboard("gr");
    expect(screen.getByTestId("where")).toHaveTextContent("/review");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.keyboard("?");
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("does nothing while typing in an input, textarea, select or contenteditable", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Shortcuts />, { route: "/today" });
    await user.click(screen.getByLabelText("Notes"));
    await user.keyboard("gl?");
    await user.click(screen.getByLabelText("Long"));
    await user.keyboard("gl?");
    await user.click(screen.getByLabelText("Rich"));
    await user.keyboard("gl?");
    screen.getByLabelText("Pick").focus();
    await user.keyboard("gl?");
    expect(screen.getByTestId("where")).toHaveTextContent("/today");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("g then a navigates even when a list under the same component binds a, and a plain a still reaches the list", async () => {
    const user = userEvent.setup();
    const a = vi.fn();
    // The list is a child, so its effects (and listener) are registered before the global one,
    // which is the order on a hard load of a list page.
    function Page() {
      useGlobalShortcuts();
      return (
        <>
          <Where />
          <List onOpen={vi.fn()} keys={{ a }} />
        </>
      );
    }
    renderWithProviders(<Page />, { route: "/leads" });
    await user.keyboard("j");
    await user.keyboard("a");
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith({ id: "a" });

    await user.keyboard("ga");
    expect(screen.getByTestId("where")).toHaveTextContent("/applications");
    expect(a).toHaveBeenCalledTimes(1);

    // a pending chord also swallows a second key that is not a destination
    await user.keyboard("gj");
    expect(screen.getByTestId("focused")).toHaveTextContent("0");
  });

  it("a g without a second key does not linger", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderWithProviders(<Shortcuts />, { route: "/today" });
      await user.keyboard("g");
      vi.advanceTimersByTime(3000);
      await user.keyboard("l");
      expect(screen.getByTestId("where")).toHaveTextContent("/today");
    } finally {
      vi.useRealTimers();
    }
  });
});
