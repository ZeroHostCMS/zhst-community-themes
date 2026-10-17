import { Button, Input, InputArea } from "@cloudflare/kumo";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
	GuestMenu as MenuData,
	GuestSession,
	GuestStatus,
	MenuItem,
	Order,
} from "@zerohost/plugin-restaurant-chain/types";
import {
	money,
	request,
	RestaurantRequestError,
	safeImage,
} from "@zerohost/plugin-restaurant-chain/client";
import {
	LanguageSelect,
	RestaurantLocale,
	useText,
} from "@zerohost/plugin-restaurant-chain/locale";
import { ChefHat, Failure, Status, useCommand, useUnsaved } from "@zerohost/plugin-restaurant-chain/ui";
import "@cloudflare/kumo/styles/standalone";
import "../styles/restaurant.css";

type BasketLine = { key: string; item: MenuItem; quantity: number; modifierIds: string[] };

function MenuDish({
	item,
	onAdd,
	disabled,
}: {
	item: MenuItem;
	onAdd: (item: MenuItem, modifierIds: string[]) => void;
	disabled: boolean;
}) {
	const { t, locale } = useText();
	const [modifiers, setModifiers] = useState<string[]>([]);
	const image = safeImage(item.image);
	const price =
		item.price +
		item.modifiers
			.filter((modifier) => modifiers.includes(modifier.id))
			.reduce((sum, modifier) => sum + modifier.price, 0);
	return (
		<article className="restaurant-dish" data-available={item.available ? "true" : "false"}>
			{image && (
				<img
					src={image}
					alt={item.name}
					width={240}
					height={200}
					loading="lazy"
					decoding="async"
					referrerPolicy="no-referrer"
				/>
			)}
			<div className="restaurant-dish-body">
				<div className="restaurant-dish-title">
					<h3>{item.name}</h3>
					<strong>{money(price, locale)}</strong>
				</div>
				{!item.available && <span className="restaurant-soldout">{t("unavailable")}</span>}
				{item.description && <p>{item.description}</p>}
				{item.modifiers.length > 0 && (
					<fieldset className="restaurant-modifiers">
						<legend>{t("modifiers")}</legend>
						{item.modifiers.map((modifier) => (
							<Button
								key={modifier.id}
								type="button"
								variant={modifiers.includes(modifier.id) ? "primary" : "secondary"}
								aria-pressed={modifiers.includes(modifier.id)}
								disabled={disabled || !item.available}
								onClick={() =>
									setModifiers(
										modifiers.includes(modifier.id)
											? modifiers.filter((id) => id !== modifier.id)
											: [...modifiers, modifier.id],
									)
								}
							>
								{modifier.name} · {money(modifier.price, locale)}
							</Button>
						))}
					</fieldset>
				)}
				<Button
					type="button"
					onClick={() => onAdd(item, modifiers)}
					disabled={disabled || !item.available}
				>
					{t(item.available ? "add" : "unavailable")}
				</Button>
			</div>
		</article>
	);
}

function GuestOrder({ order }: { order: Order }) {
	const { t, locale } = useText();
	return (
		<article className="restaurant-order">
			<header>
				<span>
					{new Intl.DateTimeFormat(locale, {
						hour: "2-digit",
						minute: "2-digit",
						timeZone: "Asia/Ho_Chi_Minh",
					}).format(new Date(order.createdAt))}
				</span>
				<Status value={order.status} />
			</header>
			{order.status === "pending" && <p className="restaurant-muted">{t("pendingHint")}</p>}
			<ul>
				{order.lines.map((line) => (
					<li key={line.id}>
						<div>
							<strong>
								{line.quantity} × {line.name}
							</strong>
							{line.modifiers.length > 0 && (
								<small>{line.modifiers.map((modifier) => modifier.name).join(", ")}</small>
							)}
							{order.status === "confirmed" && <Status value={line.kitchenStatus} />}
						</div>
						<span>{money(line.total, locale)}</span>
					</li>
				))}
			</ul>
			{order.note && (
				<p>
					{t("note")}: {order.note}
				</p>
			)}
			{order.reason && (
				<p>
					{t("reason")}: {order.reason}
				</p>
			)}
		</article>
	);
}

function GuestMenuContent({ tableToken }: { tableToken: string }) {
	const { t, locale } = useText();
	const [token, setToken] = useState("");
	const [menu, setMenu] = useState<MenuData>();
	const [status, setStatus] = useState<GuestStatus>();
	const [error, setError] = useState<unknown>();
	const [loading, setLoading] = useState(false);
	const [closed, setClosed] = useState(false);
	const [basket, setBasket] = useState<BasketLine[]>([]);
	const [note, setNote] = useState("");
	const [category, setCategory] = useState("");
	const [search, setSearch] = useState("");
	const [view, setView] = useState<"menu" | "basket" | "status">("menu");
	const [revision, setRevision] = useState(0);
	const [sent, setSent] = useState(false);
	const pinnedSubmission = useRef<{ signature: string; version: number } | undefined>(undefined);
	const join = useCommand();
	const submit = useCommand();
	const service = useCommand();
	const [online, setOnline] = useState(true);
	const refresh = useCallback(() => setRevision((value) => value + 1), []);
	useEffect(() => {
		const update = () => setOnline(navigator.onLine);
		update();
		window.addEventListener("online", update);
		window.addEventListener("offline", update);
		return () => {
			window.removeEventListener("online", update);
			window.removeEventListener("offline", update);
		};
	}, []);
	useUnsaved(basket.length > 0 || submit.pending);
	useEffect(() => {
		if (
			submit.error instanceof RestaurantRequestError &&
			/CONFLICT|VERSION/.test(submit.error.code)
		)
			pinnedSubmission.current = undefined;
	}, [submit.error]);
	useEffect(() => {
		try {
			const saved = sessionStorage.getItem(`restaurant-visit:${tableToken}`);
			if (saved) setToken(saved);
		} catch {
			/* Private browsing may deny storage; an in-memory visit still works. */
		}
	}, [tableToken]);
	useEffect(() => {
		if (!token) return;
		const controller = new AbortController();
		let running = false;
		async function load() {
			if (running) return;
			running = true;
			try {
				const [firstMenu, firstStatus] = await Promise.all([
					request<MenuData>("menu", { token, limit: 100 }, { signal: controller.signal }),
					request<GuestStatus>(
						"guest-status",
						{ token, limit: 100 },
						{ signal: controller.signal },
					),
				]);
				const items = [...firstMenu.items];
				let cursor = firstMenu.nextCursor;
				while (cursor) {
					const next = await request<MenuData>(
						"menu",
						{ token, cursor, limit: 100 },
						{ signal: controller.signal },
					);
					items.push(...next.items);
					cursor = next.nextCursor;
				}
				const orders = [...firstStatus.orders];
				cursor = firstStatus.nextCursor;
				while (cursor) {
					const next = await request<GuestStatus>(
						"guest-status",
						{ token, cursor, limit: 100 },
						{ signal: controller.signal },
					);
					orders.push(...next.orders);
					cursor = next.nextCursor;
				}
				if (!controller.signal.aborted) {
					setMenu({ ...firstMenu, items });
					setStatus({ ...firstStatus, orders });
					setClosed(
						firstStatus.visit.status === "closed" || firstStatus.visit.expiresAt <= Date.now(),
					);
					setError(undefined);
				}
			} catch (cause) {
				if (!controller.signal.aborted) {
					setError(cause);
					if (
						cause instanceof RestaurantRequestError &&
						/CLOSED|EXPIRED|SESSION|TOKEN|VISIT_NOT_FOUND/.test(cause.code)
					)
						setClosed(true);
				}
			} finally {
				running = false;
				if (!controller.signal.aborted) setLoading(false);
			}
		}
		setLoading(true);
		void load();
		const interval = window.setInterval(() => {
			if (document.visibilityState === "visible") void load();
		}, 12000);
		return () => {
			controller.abort();
			window.clearInterval(interval);
		};
	}, [token, revision]);
	async function joinVisit() {
		if (basket.length && !window.confirm(t("unsaved"))) return;
		const result = await join.run<GuestSession>("join-table", { tableToken });
		if (!result) return;
		setBasket([]);
		setNote("");
		setStatus(undefined);
		setMenu(undefined);
		setClosed(false);
		setError(undefined);
		setToken(result.token);
		setSent(false);
		pinnedSubmission.current = undefined;
		try {
			sessionStorage.setItem(`restaurant-visit:${tableToken}`, result.token);
		} catch {
			/* The visit remains usable without persistent storage. */
		}
	}
	function add(item: MenuItem, modifierIds: string[]) {
		const ids = [...modifierIds].sort();
		const key = `${item.id}:${ids.join(",")}`;
		setBasket((current) => {
			const exists = current.find((line) => line.key === key);
			if (exists)
				return current.map((line) =>
					line.key === key ? { ...line, quantity: Math.min(line.quantity + 1, 100) } : line,
				);
			return current.length < 50
				? [...current, { key, item, quantity: 1, modifierIds: ids }]
				: current;
		});
		setSent(false);
	}
	async function sendOrder() {
		if (!status || !basket.length || closed || submit.pending) return;
		const lines = basket.map((line) => ({
			menuItemId: line.item.id,
			quantity: line.quantity,
			modifierIds: line.modifierIds,
		}));
		const signature = JSON.stringify({ token, note, lines });
		if (pinnedSubmission.current?.signature !== signature)
			pinnedSubmission.current = { signature, version: status.visit.version };
		const result = await submit.run("submit-order", {
			token,
			note,
			lines,
			expectedVersion: pinnedSubmission.current.version,
		});
		if (result === undefined) return;
		pinnedSubmission.current = undefined;
		setBasket([]);
		setNote("");
		setSent(true);
		setView("status");
		refresh();
	}
	const categories = menu ? [...new Set(menu.items.map((item) => item.category))] : [];
	const visible =
		menu?.items.filter(
			(item) =>
				(!category || item.category === category) &&
				(!search.trim() ||
					`${item.name} ${item.description}`
						.toLocaleLowerCase(locale)
						.includes(search.trim().toLocaleLowerCase(locale))),
		) ?? [];
	const total = basket.reduce(
		(sum, line) =>
			sum +
			(line.item.price +
				line.item.modifiers
					.filter((modifier) => line.modifierIds.includes(modifier.id))
					.reduce((extra, modifier) => extra + modifier.price, 0)) *
				line.quantity,
		0,
	);
	const count = basket.reduce((sum, line) => sum + line.quantity, 0);
	const openKinds = new Set((status?.requests ?? []).map((entry) => entry.kind));
	const canOrder = !closed && status?.visit.status === "open";
	async function requestService(kind: "waiter" | "bill") {
		if (!token || closed || service.pending) return;
		const result = await service.run("call-service", { token, kind, note: "" });
		if (result !== undefined) refresh();
	}
	return (
		<main className="restaurant-guest">
			<header className="restaurant-header">
				<a href="#restaurant-content" className="restaurant-wordmark">
					<span className="restaurant-mark" aria-hidden="true">
						<ChefHat />
					</span>
					<span className="restaurant-wordmark-text">
						<strong>{menu?.branch.name ?? t("brandName")}</strong>
						<small>{t("brandTag")}</small>
					</span>
				</a>
				<LanguageSelect />
			</header>
			<section className="restaurant-intro">
				<div>
					<span className="restaurant-table-badge">
						{t("table")} · {menu?.branch.name ?? t("brandName")}
					</span>
					<h1>{menu?.table.name ?? t("menu")}</h1>
					<p>{t("welcome")}</p>
				</div>
				{status && <Status value={status.visit.status} />}
			</section>
			{(!token || closed) && (
				<section className="restaurant-join">
					<h2>{t(closed ? "closedState" : "join")}</h2>
					<p>{t(closed ? "closed" : "joinHint")}</p>
					<Failure error={join.error} />
					<Button
						variant="primary"
						disabled={join.pending}
						onClick={() => {
							void joinVisit();
						}}
					>
						{t(join.pending ? "saving" : "join")}
					</Button>
				</section>
			)}
			<Failure error={error} />
			{Boolean(error) && <Button onClick={refresh}>{t("retry")}</Button>}
			{!online && (
				<p role="status" className="restaurant-offline">
					{t("offline")}
				</p>
			)}
			{loading && <p role="status">{t("loading")}</p>}
			{basket.length >= 50 && (
				<p role="status" className="restaurant-notice">
					{t("basketLimit")}
				</p>
			)}
			{token && !closed && (
				<>
					<nav className="restaurant-nav" aria-label={t("menu")}>
						{(["menu", "basket", "status"] as const).map((name) => (
							<Button
								key={name}
								type="button"
								variant={view === name ? "primary" : "secondary"}
								aria-pressed={view === name}
								onClick={() => setView(name)}
							>
								{t(name)}
								{name === "basket" && count > 0 ? ` (${count})` : ""}
							</Button>
						))}
					</nav>
					<div id="restaurant-content" className="restaurant-content" aria-busy={loading}>
						{view === "menu" && (
							<>
								<p className="restaurant-notice">{t("guestHint")}</p>
								<div className="restaurant-menu-tools">
									<div className="restaurant-categories" aria-label={t("category")}>
										<Button
											type="button"
											aria-pressed={!category}
											variant={!category ? "primary" : "secondary"}
											onClick={() => setCategory("")}
										>
											{t("all")}
										</Button>
										{categories.map((name) => (
											<Button
												key={name}
												type="button"
												variant={category === name ? "primary" : "secondary"}
												aria-pressed={category === name}
												onClick={() => setCategory(name)}
											>
												{name}
											</Button>
										))}
									</div>
									<Input
										label={t("search")}
										type="search"
										value={search}
										onChange={(event) => setSearch(event.target.value)}
									/>
								</div>
								<div className="restaurant-menu-list">
									{visible.map((item) => (
										<MenuDish
											key={item.id}
											item={item}
											onAdd={add}
											disabled={!canOrder || submit.pending}
										/>
									))}
									{menu && visible.length === 0 && (
										<p className="restaurant-empty">{t("noMenu")}</p>
									)}
								</div>
							</>
						)}
						{view === "basket" && (
							<section className="restaurant-basket">
								<h2>{t("basket")}</h2>
								{basket.length === 0 ? (
									<p className="restaurant-empty">{t("basketEmpty")}</p>
								) : (
									<form
										onSubmit={(event) => {
											event.preventDefault();
											void sendOrder();
										}}
									>
										<ul>
											{basket.map((line) => (
												<li key={line.key}>
													<div>
														<h3>{line.item.name}</h3>
														<p>
															{line.item.modifiers
																.filter((modifier) => line.modifierIds.includes(modifier.id))
																.map((modifier) => modifier.name)
																.join(", ")}
														</p>
													</div>
													<Input
														label={t("quantity")}
														type="number"
														min={1}
														max={100}
														step={1}
														required
														disabled={submit.pending}
														value={line.quantity}
														onChange={(event) => {
															const quantity = Number(event.target.value);
															setBasket(
																basket.map((entry) =>
																	entry.key === line.key ? { ...entry, quantity } : entry,
																),
															);
														}}
													/>
													<Button
														type="button"
														disabled={submit.pending}
														aria-label={`${t("remove")} ${line.item.name}`}
														onClick={() =>
															setBasket(basket.filter((entry) => entry.key !== line.key))
														}
													>
														{t("remove")}
													</Button>
												</li>
											))}
										</ul>
										<InputArea
											label={t("note")}
											value={note}
											maxLength={1000}
											disabled={submit.pending}
											onChange={(event) => setNote(event.target.value)}
										/>
										<div className="restaurant-total">
											<strong>{t("total")}</strong>
											<strong>{money(total, locale)}</strong>
										</div>
										<p className="restaurant-muted">{t("estimate")}</p>
										<Failure error={submit.error} />
										<Button type="submit" variant="primary" disabled={!canOrder || submit.pending}>
											{t(submit.pending ? "saving" : "submit")}
										</Button>
									</form>
								)}
								<Button type="button" onClick={() => setView("menu")}>
									{t("backToMenu")}
								</Button>
							</section>
						)}
						{view === "status" && (
							<section className="restaurant-status">
								<div className="restaurant-section-heading">
									<h2>{t("status")}</h2>
									<Button onClick={refresh} disabled={loading}>
										{t("refresh")}
									</Button>
								</div>
								{sent && (
									<p role="status" className="restaurant-success">
										{t("sent")}
									</p>
								)}
								{status?.orders.map((order) => (
									<GuestOrder key={order.id} order={order} />
								))}
								{status?.orders.length === 0 && <p className="restaurant-empty">{t("noOrders")}</p>}
								<div className="restaurant-total">
									<strong>{t("total")}</strong>
									<strong>{money(status?.total ?? 0, locale)}</strong>
								</div>
								<div className="restaurant-service">
									<Button
										type="button"
										variant="secondary"
										disabled={service.pending || openKinds.has("waiter")}
										onClick={() => {
											void requestService("waiter");
										}}
									>
										{t(openKinds.has("waiter") ? "alreadyRequested" : "callWaiter")}
									</Button>
									<Button
										type="button"
										variant="secondary"
										disabled={service.pending || openKinds.has("bill")}
										onClick={() => {
											void requestService("bill");
										}}
									>
										{t(openKinds.has("bill") ? "alreadyRequested" : "requestBill")}
									</Button>
								</div>
								<Failure error={service.error} />
								{openKinds.size > 0 && (
									<p role="status" className="restaurant-success">
										{t("requestSent")}
									</p>
								)}
								<p className="restaurant-muted">{t("paymentHint")}</p>
							</section>
						)}
					</div>
					{count > 0 && view === "menu" && (
						<aside className="restaurant-basket-dock">
							<div>
								<strong>
									{t("basket")} ({count})
								</strong>
								<span>{money(total, locale)}</span>
							</div>
							<Button variant="primary" type="button" onClick={() => setView("basket")}>
								{t("orderAtTable")}
							</Button>
						</aside>
					)}
				</>
			)}
			<footer className="restaurant-footer">{t("online")}</footer>
		</main>
	);
}

export function GuestMenu({ tableToken }: { tableToken: string }) {
	return (
		<RestaurantLocale>
			<GuestMenuContent key={tableToken} tableToken={tableToken} />
		</RestaurantLocale>
	);
}
export default GuestMenu;
