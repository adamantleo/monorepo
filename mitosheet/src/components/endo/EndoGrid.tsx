import React, { useEffect, useMemo, useRef, useState } from "react";
import '../../../css/endo/EndoGrid.css';
import '../../../css/sitewide/colors.css';
import MitoAPI from "../../api";
import { EditorState, Dimension, GridState, RendererTranslate, SheetData, SheetView, UIState } from "../../types";
import FormulaBar from "./FormulaBar";
import { TaskpaneType } from "../taskpanes/taskpanes";
import CellEditor from "./CellEditor";
import { getCellEditorInputCurrentSelection, getStartingFormula } from "./cellEditorUtils";
import ColumnHeaders from "./ColumnHeaders";
import EmptyGridMessages from "./EmptyGridMessages";
import { focusGrid } from "./focusUtils";
import GridData from "./GridData";
import IndexHeaders from "./IndexHeaders";
import { equalSelections, getColumnIndexesInSelections, getIndexesFromMouseEvent, getIsCellSelected, getIsHeader, getNewSelectionAfterKeyPress, getNewSelectionAfterMouseUp, isNavigationKeyPressed, isSelectionsOnlyColumnHeaders, reconciliateSelections, removeColumnFromSelections } from "./selectionUtils";
import { calculateCurrentSheetView, calculateNewScrollPosition, calculateTranslate} from "./sheetViewUtils";
import { firstNonNullOrUndefined, getColumnIDsArrayFromSheetDataArray } from "./utils";
import { ensureCellVisible } from "./visibilityUtils";
import { reconciliateWidthDataArray } from "./widthUtils";

// NOTE: these should match the css
export const DEFAULT_WIDTH = 123;
export const DEFAULT_HEIGHT = 25;
export const MIN_WIDTH = 50;

// The maximum number of rows sent in the sheet data by the backend
export const MAX_ROWS = 1500;


export const KEYS_TO_IGNORE_IF_PRESSED_ALONE = [
    'Shift',
    'Meta',
    'Alt',
    'Control',
    'CapsLock',
    'Unidentified' // If you press the fn key on windows, this is the key
]

function EndoGrid(props: {
    sheetDataArray: SheetData[],
    sheetIndex: number,
    mitoAPI: MitoAPI,
    uiState: UIState;
    setUIState: React.Dispatch<React.SetStateAction<UIState>>;

    /* 
        The state of the grid is represented by a viewport with a height and width,
        the scroll position of the scroller div in the viewport, and the selected 
        range of cells within the grid.

        We default the selection to -2s so that nothing is selected and all our selection
        code doesn't need to handle too many special cases.

        We store all of this state in a single object as if any of them change, the entire
        grid (the data, the headers) needs to rerender. Thus, we don't want to set them
        indivigually so that we can limit the amount of unnecessary rerendering we do.

        Only put state in here that causes a rerender of the entire grid when any element changes
        and is consistently passed as props to the grid and headers.
    */
    gridState: GridState,
    setGridState: React.Dispatch<React.SetStateAction<GridState>>,

    /* 
        If editorState is undefined, then the sheet is in normal navigation 
        mode. Otherwise, if editorState is not undefined, then the cell 
        editor is displaying, and all inputs may be captured and processed by
        the cell editor. 

        The way to think about this is that the sheet can be in two states; 
        1.  Navigation: when editorState is undefined.
        2.  Editing: when editorState is not undefined. 
        
        These will be processed different by many of the input handling functions,
        like mouse events, key events, etc.
    */
    editorState: EditorState | undefined,
    setEditorState: React.Dispatch<React.SetStateAction<EditorState | undefined>>
}): JSX.Element {

    // The container for the entire EndoGrid
    const containerRef = useRef<HTMLDivElement>(null);
    // The container for just the empty scroll div, and the rendered grid data
    const scrollAndRenderedContainerRef = useRef<HTMLDivElement>(null);
    // Store if the mouse is currently pressed down on the grid
    const [mouseDown, setMouseDown] = useState(false);
    
    // Destructure the props, so we access them more directly in the component below
    const {
        sheetDataArray, sheetIndex,
        gridState, setGridState, 
        editorState, setEditorState, 
        uiState, setUIState,
        mitoAPI
    } = props;

    const sheetData = sheetDataArray[sheetIndex];

    const totalSize: Dimension = {
        width: gridState.widthDataArray[gridState.sheetIndex]?.totalWidth || 0,
        height: DEFAULT_HEIGHT * Math.min(sheetData?.numRows || 0, MAX_ROWS)
    }
    
    const currentSheetView: SheetView = useMemo(() => {
        return calculateCurrentSheetView(gridState)
    }, [gridState])

    const translate: RendererTranslate = useMemo(() => {
        return calculateTranslate(gridState);
    }, [gridState])

    /* 
        An effect that handles the sheet data changing, in which case
        we have to perform a reconciliation of width data, as well 
        as the selection

        Columns may have been deleted or added. We need to make sure that
        the widths and selection track these changes correctly.
    */
    useEffect(() => {
        setGridState(gridState => {
            return {
                ...gridState,
                selections: reconciliateSelections(gridState.sheetIndex, sheetIndex, gridState.selections, gridState.columnIDsArray[gridState.sheetIndex], sheetData),
                widthDataArray: reconciliateWidthDataArray(gridState.widthDataArray, gridState.columnIDsArray, sheetDataArray),
                columnIDsArray: getColumnIDsArrayFromSheetDataArray(sheetDataArray),
                sheetIndex: sheetIndex
            }
        })
    }, [sheetData, setGridState, sheetIndex])


    /* 
        An effect that handles a resizing of the viewport. Notably, the resize
        event is only triggered on the window event, so we cannot just add
        a resize event lister to the grid element and expect it to work. 
        See here: https://developer.mozilla.org/en-US/docs/Web/API/Window/resize_event

        Thus, we use a resize observer. 
        See here: https://developer.mozilla.org/en-US/docs/Web/API/Resize_Observer_API
    */
    useEffect(() => {
        const resizeViewport = () => {
            setGridState((gridState) => {
                return {
                    ...gridState,
                    viewport: {
                        width: scrollAndRenderedContainerRef?.current?.clientWidth || 0,
                        height: scrollAndRenderedContainerRef?.current?.clientHeight || 0,
                    }
                }
            })
        };

        // Double calc the viewport size, just to make sure it loads properly
        resizeViewport();
        setTimeout(() => resizeViewport(), 250)

        const resizeObserver = new ResizeObserver(() => {
            resizeViewport();
        })

        const containerDiv = containerRef.current; 
        if (containerDiv) {
            resizeObserver.observe(containerDiv);
        }
        
        return () => {
            resizeObserver.disconnect();
        }
    }, [setGridState])

    // Handles a scroll inside the grid 
    const onGridScroll = (e: React.UIEvent<HTMLDivElement, UIEvent>) => {
        const newScrollPosition = calculateNewScrollPosition(
            e,
            totalSize,
            gridState.viewport,
            scrollAndRenderedContainerRef.current
        )

        if (newScrollPosition !== undefined) {
            setGridState((gridState) => {
                return {
                    ...gridState,
                    scrollPosition: newScrollPosition
                }
            })
        }
    };


    const onMouseDown = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
        if (editorState !== undefined) {
            // EDITING MODE

            const {rowIndex, columnIndex} = getIndexesFromMouseEvent(e);

            // If we're editing a column header and we click a different cell, then close
            // the editor without submitting, as we assume the user is just trying to get
            // out of the editor
            if (editorState.rowIndex === -1 && (rowIndex !== editorState.rowIndex || columnIndex !== editorState.columnIndex)) {
                setEditorState(undefined);
                return;
            }

            
            if (columnIndex !== undefined && sheetData?.data[columnIndex] !== undefined) {

                // Get the column that was clicked, and then find the current selection
                // within the cell editor, so that we can place the column header correctly
                const {selectionStart, selectionEnd} = getCellEditorInputCurrentSelection(containerRef.current);


                // If there is already some suggested column headers, we do not change this selection, 
                // as we want any future expanded selection of column headers to overwrite the same 
                // region. So default to pendingSelectedColumns?.selectionStart, but if this does not
                // exist, than take the selection range in the input currently
                const newSelectionStart = firstNonNullOrUndefined(
                    editorState.pendingSelectedColumns?.selectionStart,
                    selectionStart
                )
                const newSelectionEnd = firstNonNullOrUndefined(
                    editorState.pendingSelectedColumns?.selectionEnd,
                    selectionEnd
                )

                // Select the column that was clicked on, as they do in Excel
                setGridState(prevGridState => {
                    return {
                        ...prevGridState,
                        selections: [{
                            startingRowIndex: rowIndex !== undefined ? rowIndex : -1,
                            endingRowIndex: rowIndex !== undefined ? rowIndex : -1,
                            startingColumnIndex: columnIndex,
                            endingColumnIndex: columnIndex,
                        }]
                    }
                })

                return setEditorState({
                    ...editorState,
                    pendingSelectedColumns: {
                        columnHeaders: [sheetData.data[columnIndex].columnHeader],
                        selectionStart: newSelectionStart,
                        selectionEnd: newSelectionEnd,
                    },
                    /* If you click on a cell, you should now scroll in the sheet */
                    arrowKeysScrollInFormula: false
                });
            }
            return;
        } else {
            // NAVIGATION MODE

            // First, we make sure that the grid is focused on
            focusGrid(containerRef.current);

            // Set state so we know mouse is down
            setMouseDown(true);

            // Update the selection
            const {rowIndex, columnIndex} = getIndexesFromMouseEvent(e);

            // If the click was not on a cell, return
            if (rowIndex === undefined || columnIndex === undefined) {
                return;
            }

            if (e.metaKey) {
                if (e.shiftKey) {
                    // Just add the new click locaton to a new selection at the end of the selections list
                    setGridState((gridState) => {
                        const selectionsCopy = [...gridState.selections]
                        selectionsCopy.push({
                            startingRowIndex: rowIndex,
                            endingRowIndex: rowIndex,
                            startingColumnIndex: columnIndex,
                            endingColumnIndex: columnIndex,
                        })
                        return {
                            ...gridState,
                            selections: selectionsCopy
                        }
                    })
                // The next step of conditions handle when meta key is pressed and shift is not
                } else {
                    if (rowIndex === -1) {
                        // If column is in selection, then remove it
                        // By passing -1 as the row index, getIsCellSelected checks if the entire column is selected
                        if (getIsCellSelected(gridState.selections, -1, columnIndex)) {
                            setGridState((gridState) => {
                                return {
                                    ...gridState,
                                    selections: removeColumnFromSelections(gridState.selections, columnIndex)
                                }
                            })
                        } else {
                            // If column is not in selection, append a new selection
                            setGridState((gridState) => {
                                const selectionsCopy = [...gridState.selections]
                                selectionsCopy.push({
                                    startingRowIndex: rowIndex,
                                    endingRowIndex: rowIndex,
                                    startingColumnIndex: columnIndex,
                                    endingColumnIndex: columnIndex,
                                })
                                return {
                                    ...gridState,
                                    selections: selectionsCopy
                                }
                            })
                        }
                    } else {
                        // If the row, col they clicked in not in the selection, then append it to the end 
                        if (!getIsCellSelected(props.gridState.selections, rowIndex, columnIndex)) {
                            const selectionsCopy = [...gridState.selections]
                            selectionsCopy.push({
                                startingRowIndex: rowIndex,
                                endingRowIndex: rowIndex,
                                startingColumnIndex: columnIndex,
                                endingColumnIndex: columnIndex,
                            })
                            setGridState((gridState) => {
                                return {
                                    ...gridState,
                                    selections: selectionsCopy
                                }
                            })
                        } else {
                            // If the (row, col) is in the selections, then make the selections just this element
                            // TODO: In the future, this should deselect the specific cell that they clicked on.
                            setGridState((gridState) => {
                                return {
                                    ...gridState,
                                    selections: [{
                                        startingRowIndex: rowIndex,
                                        endingRowIndex: rowIndex,
                                        startingColumnIndex: columnIndex,
                                        endingColumnIndex: columnIndex,
                                    }]
                                }
                            })
                        }
                    }
                }
                return;
            } else {
                if (e.shiftKey) {
                    // If the shift key is down, we extend the current selection
                    const selectionsCopy = [...gridState.selections]
                    selectionsCopy[selectionsCopy.length - 1] = getNewSelectionAfterMouseUp(selectionsCopy[selectionsCopy.length - 1], rowIndex, columnIndex)
                    setGridState((gridState) => {
                        return {
                            ...gridState,
                            selections: selectionsCopy
                        }
                    })
                } else {
                    // Clear the entire selection, and create a new one. 
                    setGridState((gridState) => {
                        return {
                            ...gridState,
                            selections: [{
                                startingRowIndex: rowIndex,
                                endingRowIndex: rowIndex,
                                startingColumnIndex: columnIndex,
                                endingColumnIndex: columnIndex,
                            }]
                        }
                    })
                }
            }

            // If the user is clicking on the index column, we make sure to close the control
            // panel if it's open, so we don't display something empty
            if (columnIndex === -1) {
                setUIState(prevUIState => {
                    if (prevUIState.currOpenTaskpane.type === TaskpaneType.CONTROL_PANEL) {
                        return {
                            ...prevUIState, 
                            currOpenTaskpane: {type: TaskpaneType.NONE}
                        }
                    }
                    return prevUIState;
                })
            }
        }
    }


    const onMouseUp = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
        // TODO: Figure out why this doesn't get triggered when the user is pressing
        // the shift key. It results in weird behavior where if the user
        // has pressed the shift key to make a selection, the selection box
        // follows their cursor, even once they have lifted their mouse up.

        // Do nothing, if we're in EDITING mode. Clicks handled by onMouseDown
        if (editorState !== undefined) {
            return;
        }

        // Make sure the grid is focused
        focusGrid(containerRef.current);

        // Mark that the mouse is no longer down
        setMouseDown(false);

        const {rowIndex, columnIndex} = getIndexesFromMouseEvent(e);

        // If the shift key or metaKey is down, then this is handled by the onMouseDown
        if (e.shiftKey || e.metaKey) {
            return;
        }

        const newLastSelection = getNewSelectionAfterMouseUp(gridState.selections[gridState.selections.length - 1], rowIndex, columnIndex);
        const newSelections = [...gridState.selections]
        newSelections[newSelections.length - 1] = newLastSelection
        // We only update the selection if has changed, so we don't rerender unnecessarily
        if (!equalSelections(newLastSelection, gridState.selections[gridState.selections.length - 1])) {
            setGridState((gridState) => {
                return {
                    ...gridState,
                    selections: newSelections
                }
            })
        }
    }

    // An effect so that when the mouse is down, the selection tracks where
    // the mouse is and updates live
    useEffect(() => {
        if (mouseDown) {
            const updateSelectionOnMouseDrag = (e: MouseEvent) => {

                const {rowIndex, columnIndex} = getIndexesFromMouseEvent(e);
                
                setGridState((gridState) => {
                    const newLastSelection = getNewSelectionAfterMouseUp(gridState.selections[gridState.selections.length - 1], rowIndex, columnIndex);
                    const newSelections = [...gridState.selections]
                    newSelections[newSelections.length - 1] = newLastSelection
                    return {
                        ...gridState,
                        selections: newSelections
                    }
                })
            }
            const containerDiv = containerRef.current; 

            // We don't allow the drag and drop selections if you're starting from a column 
            // header, because the headers themselves are draggable and droppable
            if (gridState.selections[gridState.selections.length - 1].startingRowIndex === -1) {
                return;
            }

            containerDiv?.addEventListener('mousemove', updateSelectionOnMouseDrag);
            return () => {
                containerDiv?.removeEventListener('mousemove', updateSelectionOnMouseDrag)
            }
        }
    }, [mouseDown, gridState, setGridState])

    // On double click, open the cell editor on this cell
    const onDoubleClick = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
        const {rowIndex, columnIndex} = getIndexesFromMouseEvent(e);
        // Don't open for headers
        if ((rowIndex === undefined || columnIndex === undefined) || getIsHeader(rowIndex, columnIndex)) {
            return;
        }

        const startingFormula = getStartingFormula(sheetData, rowIndex, columnIndex);

        setEditorState({
            rowIndex: rowIndex,
            columnIndex: columnIndex,
            formula: startingFormula,
            // As in google sheets, if the starting formula is non empty, we default to the 
            // arrow keys scrolling in the editor
            arrowKeysScrollInFormula: startingFormula.length > 0
        })
    }
    

    // Effect listeners for when keys are pressed
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {

            // If we're in editing mode, then we don't do anything with the keyboard 
            // events as they are handeled by the cell editor state machine!
            if (editorState !== undefined) {
                return;
            }
            
            if (KEYS_TO_IGNORE_IF_PRESSED_ALONE.includes(e.key)) {
                return;
            }

            if (!isNavigationKeyPressed(e.key)) {
                
                
                // If the metaKey is pressed, the user might be refreshing the page for example, 
                // so we just return here
                if (e.metaKey || e.key === 'Escape') {
                    return;
                }

                // If the key pressed backspace or delete key, and the user is selecting some column headers,
                // then we delete the columns they have selected
                if ((e.key === 'Backspace' || e.key === 'Delete') && isSelectionsOnlyColumnHeaders(gridState.selections)) {
                    const columnIndexesSelected = getColumnIndexesInSelections(gridState.selections);
                    const columnIDsToDelete = columnIndexesSelected.map(colIdx => sheetData?.data[colIdx]?.columnID)

                    if (columnIDsToDelete !== undefined) {
                        void mitoAPI.sendDeleteColumn(
                            sheetIndex,
                            columnIDsToDelete
                        )
                    }

                    return;
                } 

                // If we press any key that is not a navigation key, then we open the editor
                setGridState((gridState) => {
                    const lastSelection = gridState.selections[gridState.selections.length - 1]

                    const startingFormula = getStartingFormula(sheetData, lastSelection.startingRowIndex, lastSelection.startingColumnIndex, e);
                    
                    setEditorState({
                        rowIndex: lastSelection.startingRowIndex,
                        columnIndex: lastSelection.startingColumnIndex,
                        formula: startingFormula,
                        // As in google sheets, if the starting formula is non empty, we default to the 
                        // arrow keys scrolling in the editor
                        arrowKeysScrollInFormula: startingFormula.length > 0
                    });

                    e.preventDefault();

                    return {
                        ...gridState,
                        selections: [{
                            startingRowIndex: lastSelection.startingRowIndex,
                            endingRowIndex: lastSelection.startingRowIndex,
                            startingColumnIndex: lastSelection.startingColumnIndex,
                            endingColumnIndex: lastSelection.startingColumnIndex
                        }]
                    }
                })
                
                return;
            } else {
                // Otherwise, a navigation key was pressed, and so we should navigate!

                // Prevent the default of the key (to scroll or tab)
                e.preventDefault()

                // Update the selection
                setGridState((gridState) => {
                    const newSelection = getNewSelectionAfterKeyPress(gridState.selections[gridState.selections.length - 1], e, sheetData);
                    ensureCellVisible(
                        containerRef.current, scrollAndRenderedContainerRef.current,
                        currentSheetView, gridState,
                        newSelection.endingRowIndex, newSelection.endingColumnIndex
                    );

                    return {
                        ...gridState,
                        selections: [newSelection]
                    };
                })

            }
        }

        const containerDiv = containerRef.current; 
        containerDiv?.addEventListener('keydown', onKeyDown);
        return () => containerDiv?.removeEventListener('keydown', onKeyDown)
    }, [editorState, setEditorState, sheetData, currentSheetView, mitoAPI, gridState.selections, sheetIndex, setGridState])


    return (
        <>
            <FormulaBar
                sheetData={sheetData}
                selection={gridState.selections[gridState.selections.length - 1]}
                editorState={editorState}
            />
            <div 
                className='endo-grid-container' 
                ref={containerRef}
                tabIndex={-1} 
                onMouseDown={onMouseDown} 
                onMouseUp={onMouseUp} 
                onMouseLeave={() => setMouseDown(false)}
                onDoubleClick={onDoubleClick}
            >
                {sheetData !== undefined &&
                    <>
                        <ColumnHeaders
                            sheetData={sheetData}
                            setUIState={setUIState}
                            sheetIndex={sheetIndex}
                            containerRef={containerRef}
                            editorState={editorState}
                            setEditorState={setEditorState}
                            scrollAndRenderedContainerRef={scrollAndRenderedContainerRef}
                            gridState={gridState}
                            setGridState={setGridState}
                            mitoAPI={mitoAPI}
                        />
                        <IndexHeaders
                            sheetData={sheetData}
                            gridState={gridState}
                        />
                    </>
                }
                
                <div className="endo-scroller-and-renderer-container" ref={scrollAndRenderedContainerRef} onScroll={onGridScroll}>
                    {/* 
                        We handle the case where this no data in the sheet just by returning an empty
                        container with an optional message of your choosing! 

                        Note that we do not return this in a different return statement, as we always
                        want the refs defined on these components to be defined (even if there is no 
                        data). This simplifies logic in handling refs going from not defined to defined,
                        if a user renders an empty sheet, then adds data to it.
                    */}
                    <EmptyGridMessages
                        sheetData={sheetData}
                    />
                    {/* 
                        This is the div we actually scroll inside. We make it so it's styled
                        to be the size of all the data if it was displayed.
                    */}
                    <div 
                        id='scroller' 
                        style={{
                            height: `${totalSize.height}px`,
                            width: `${totalSize.width}px`
                        }} 
                    />
                    {/* We use the rendererStyle to move the grid data to the right location */}
                    <div 
                        className="renderer" 
                        style={{
                            transform: `translate(${gridState.scrollPosition.scrollLeft - translate.x}px, ${gridState.scrollPosition.scrollTop - translate.y}px)`,
                        }}
                    >
                        <GridData
                            sheetData={sheetData}
                            gridState={gridState}
                            uiState={uiState}
                            editorState={editorState}

                        />
                    </div>
                </div>
                {sheetData !== undefined && editorState !== undefined && editorState.rowIndex > -1 &&
                    <CellEditor
                        sheetData={sheetData}
                        sheetIndex={sheetIndex}
                        gridState={gridState}
                        editorState={editorState}
                        setGridState={setGridState}
                        setEditorState={setEditorState}
                        scrollAndRenderedContainerRef={scrollAndRenderedContainerRef}
                        containerRef={containerRef}
                        mitoAPI={mitoAPI}
                    />
                }
            </div>
        </>
    )
}

export default EndoGrid;
